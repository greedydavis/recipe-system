"""把《餐廳菜單_完整試作與配方表.xlsx》轉成系統可匯入的 JSON。

用法：
    python scripts/import_baseline.py [xlsx 路徑] [輸出路徑]

預設讀取上一層資料夾的基準版 xlsx，輸出到 private/baseline-seed.json（private/ 不進 git）。
輸出後在系統「更多 → 資料匯出與匯入」選擇這個檔案匯入。

轉換規則：
- 「基底湯食譜」的每一種湯底 → 元件（湯底）v1；用量齊全時自動送「試菜中」，菜品才能引用
- 「菜單試作表」的每一列 → 菜品 v1 草案；欄位名稱當作用料分組
- 有寫克重的用料帶入用量；沒寫的用量留空（系統顯示「用量待填」）
- 範圍（例如 0–10 ml）不猜數字，用量留空並把範圍寫進處理方式
- 「前置／出餐」作法轉成步驟；試作觀察與資料疑點寫進版本備註
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = ROOT.parent / "餐廳菜單_完整試作與配方表.xlsx"
DEFAULT_OUT = ROOT / "private" / "baseline-seed.json"

SOUP_COMPONENTS = {"上湯": "上湯", "魚高湯": "魚高湯（黃魚奶白）"}

# 同一種原物料的不同寫法 → (標準名稱, 處理方式)
ALIASES = {
    "蛤蠣": ("蛤蜊", ""),
    "蔥花": ("青蔥", "切蔥花"),
    "薑片": ("薑", "切片"),
    "冷水": ("水", "冷水"),
    "熱水": ("水", "熱水"),
    "飲用水": ("水", "飲用水"),
    "蒜油或蔥油": ("蔥油", "或改用蒜油"),
    "胡麻陳醋麵": ("胡麻陳醋醬", "原表寫「胡麻陳醋麵」，推測為醬汁"),
    "生麵": ("生麵條", ""),
    "檸檬片": ("檸檬", "切片"),
}

CATEGORY = {
    "meat": ["雞骨架", "豬大骨", "老母雞／雞腿骨", "去骨腿排", "雞清胸", "帶骨雞腿", "雞腿肉"],
    "seafood": ["蛤蜊", "魚片", "黃魚骨／魚體"],
    "produce": ["青蔥", "薑", "蔥白", "絲瓜", "檸檬"],
    "dry_goods": ["乾香菇", "蝦米", "老菜圃", "雪菜"],
    "seasoning": ["鹽", "白胡椒"],
    "oil": ["食用油", "芝麻油", "香油"],
    "grain": ["生麵條"],
    "beverage": ["烏龍茶葉", "酸梅湯原液"],
}

# 店內自製的半成品：先建成原物料，備註提醒之後改成元件食譜
PREPARED = {"老菜圃料汁", "蛋絲", "蔥油", "炸蒜片", "鹽蔥花", "酥炸蔥", "蔥蒜油", "拌麵醬汁", "臭豆腐炸醬", "胡麻陳醋醬", "茶湯", "糖漿", "餛飩"}
VOLUME_HINTS = ("油", "汁", "水", "糖漿", "原液", "茶湯")

GROUP_LABEL = {
    "基底湯／液體": "湯底／液體",
    "蛋白質": "蛋白質",
    "蔬菜／配料": "蔬菜／配料",
    "香料／辛香料": "辛香料",
    "油脂": "油脂",
    "Sauce／調味": "調味",
    "麵量": "麵",
}

ITEM_RE = re.compile(r"^(?P<name>.+?)\s*(?P<rest>(?:約\s*)?\d.*)?$")
QTY_RE = re.compile(r"(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>g|ml)\b")
RANGE_RE = re.compile(r"\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*(?:g|ml)")


def clean(text) -> str:
    return re.sub(r"[ 　]+", " ", str(text or "")).strip()


def split_items(cell) -> list[str]:
    text = clean(cell)
    if not text or text == "無":
        return []
    parts = re.split(r"[\n、]", text)
    return [p.strip() for p in parts if p.strip() and p.strip() != "無"]


def parse_item(raw: str) -> dict:
    """「湯底 300 ml」「鹽 1 g（視鹹度）」「某某片 3 片／約 15 g」「糖漿 0–5 ml」"""
    note = ""
    paren = re.search(r"[（(](.+?)[）)]", raw)
    if paren:
        note = paren.group(1)
        raw = (raw[: paren.start()] + raw[paren.end():]).strip()
    m = ITEM_RE.match(raw)
    name = clean(m.group("name")) if m else raw
    # 「某某醬   g」：有單位但沒填數字
    name = re.sub(r"\s+(?:g|ml)$", "", name)
    rest = (m.group("rest") or "") if m else ""
    qty = None
    unit = None
    if RANGE_RE.search(rest):
        note = "；".join(x for x in [rest.strip(), note] if x)
    else:
        q = None
        for q in QTY_RE.finditer(rest):
            pass  # 取最後一個（「2 片／約 20 g」取 20 g）
        if q:
            qty = float(q.group("qty"))
            qty = int(qty) if qty.is_integer() else qty
            unit = q.group("unit")
            extra = rest[: q.start()].strip(" ／/約")
            if extra:
                note = "；".join(x for x in [extra, note] if x)
    return {"name": name, "quantity": qty, "unit": unit, "note": note}


class Registry:
    def __init__(self):
        self.items: dict[str, dict] = {}

    def resolve(self, name: str, unit: str | None) -> tuple[str, str]:
        canonical, prep = ALIASES.get(name, (name, ""))
        if canonical not in self.items:
            if unit == "ml" or (unit is None and canonical.endswith(VOLUME_HINTS)):
                base = "volume"
            else:
                base = "mass"
            category = next((c for c, names in CATEGORY.items() if canonical in names), "other")
            note = "自製半成品：之後建立元件食譜後，建議改為引用元件" if canonical in PREPARED else ""
            self.items[canonical] = {
                "name": canonical,
                "category": category,
                "base_dimension": base,
                "density_g_per_ml": 1 if canonical == "水" else None,
                "note": note,
            }
        return canonical, prep


def line_for(item: dict, registry: Registry, group: str) -> dict:
    name = item["name"]
    prep_parts = [item["note"]]
    for soup_key, soup_name in SOUP_COMPONENTS.items():
        if name == soup_key:
            return {
                "component": soup_name,
                "quantity": item["quantity"],
                "unit": item["unit"] or "ml",
                "prep_note": "；".join(p for p in prep_parts if p),
                "group_label": group,
            }
    canonical, prep = registry.resolve(name, item["unit"])
    base = registry.items[canonical]["base_dimension"]
    unit = item["unit"] or ("ml" if base == "volume" else "g")
    if canonical != name and not prep:
        prep_parts.insert(0, f"原表寫「{name}」")
    return {
        "ingredient": canonical,
        "quantity": item["quantity"],
        "unit": unit,
        "prep_note": "；".join(p for p in [prep, *prep_parts] if p),
        "group_label": group,
    }


def parse_shelf_life(text: str) -> tuple[int | None, str]:
    """「建議 24–48 小時內用畢」→ (24, "24–48")；取較短的時間比較保守"""
    m = re.search(r"(\d+)(?:\s*[–-]\s*(\d+))?\s*小時內用畢", text or "")
    if not m:
        return None, ""
    return int(m.group(1)), (f"{m.group(1)}–{m.group(2)}" if m.group(2) else m.group(1))


def build_soups(ws, registry: Registry, dishes: list[dict]) -> list[dict]:
    rows = [[c.value for c in r] for r in ws.iter_rows(min_row=5)]
    soups: dict[str, dict] = {}
    for soup, part, qty, unit, process, heat, storage, observe in rows:
        if not soup:
            continue
        key = "上湯" if str(soup).startswith("上湯") else "魚高湯"
        s = soups.setdefault(key, {"lines": [], "steps": [], "storage": "", "observe": [], "output": None, "yield_note": ""})
        if observe:
            s["observe"].append(f"{part}：{observe}")
        if storage and "成品" not in str(storage):
            s["storage"] = clean(storage)
        elif storage:
            s["yield_note"] = clean(storage)
        process_text = clean(process)
        heat_text = clean(heat)
        if part == "過濾與定量":
            m = re.search(r"\d+", str(qty))
            s["output"] = int(m.group()) if m else None
            s["steps"].append(
                {
                    "instruction": f"過濾與定量：{process_text}",
                    "is_critical": True,
                    "critical_note": "快速冷卻：2 小時內降至 21°C 以下，再 4 小時內降至 5°C 以下",
                }
            )
            continue
        # 「薑片／蔥白 120 g」製程欄寫「薑 80 g、蔥白 40 g」→ 拆成兩行
        split = re.findall(r"(薑|蔥白)\s*(\d+)\s*g", process_text)
        if split:
            for name, amount in split:
                canonical, prep = registry.resolve(name, "g")
                s["lines"].append({"ingredient": canonical, "quantity": int(amount), "unit": "g", "prep_note": prep, "group_label": ""})
        else:
            canonical, prep = registry.resolve(clean(part), unit)
            s["lines"].append({"ingredient": canonical, "quantity": qty, "unit": unit, "prep_note": prep, "group_label": ""})
        s["steps"].append({"instruction": f"{clean(part)}：{process_text}" + (f"（{heat_text}）" if heat_text else "")})

    recipes = []
    for key, s in soups.items():
        name = SOUP_COMPONENTS[key]
        hours, hours_text = parse_shelf_life(s["storage"])
        # 每份量：菜品引用這個湯底時最常用的量
        usages = Counter(
            line["quantity"]
            for dish in dishes
            for line in dish["version"]["lines"]
            if line.get("component") == name and line["quantity"]
        )
        serving = usages.most_common(1)[0][0] if usages else None
        notes = ["試作觀察重點：", *[f"・{o}" for o in s["observe"]]]
        if s["yield_note"]:
            notes.append(f"成品說明：{s['yield_note']}")
        if serving:
            others = "、".join(f"{q} ml" for q in sorted(usages) if q != serving)
            notes.append(f"每份量暫以菜品最常用的 {serving} ml 計" + (f"；其他菜品用量：{others}" if others else "") + "。")
        if hours:
            notes.append(f"保存期限：原表建議 {hours_text} 小時內用畢，系統暫記 {hours} 小時。")
        recipes.append(
            {
                "name": name,
                "type": "component",
                "component_kind": "soup",
                "description": "基準版：約 10 L 成品批次（第一版試作基準，需經實際試菜校正）",
                "to_testing": True,
                "version": {
                    "title": "基準版",
                    "change_note": "由《餐廳菜單_完整試作與配方表》匯入",
                    "batch_output_qty": s["output"],
                    "batch_output_unit": "ml",
                    "serving_qty": serving,
                    "serving_unit": "ml",
                    "storage_method": s["storage"],
                    "shelf_life_hours": hours,
                    "notes": "\n".join(notes),
                    "lines": s["lines"],
                    "steps": s["steps"],
                },
            }
        )
    return recipes


def build_dishes(ws, standard_ws, registry: Registry) -> list[dict]:
    header = [clean(c.value) for c in ws[4]]
    noodle_standard = {}
    for r in standard_ws.iter_rows(min_row=5, values_only=True):
        if r[0]:
            noodle_standard[clean(r[0])] = clean(r[1])

    recipes = []
    for r in ws.iter_rows(min_row=5, values_only=True):
        if not r[1]:
            continue
        row = dict(zip(header, r))
        category = clean(row["分類"])
        name = clean(row["原菜名"])
        lines = []
        for col in ["基底湯／液體", "蛋白質", "蔬菜／配料", "香料／辛香料", "油脂", "Sauce／調味", "麵量"]:
            for raw in split_items(row.get(col)):
                lines.append(line_for(parse_item(raw), registry, GROUP_LABEL[col]))

        steps = []
        method = str(row.get("第一版建議作法") or "")
        for label in ["前置", "出餐"]:
            m = re.search(rf"{label}：(.*?)(?=\n\s*(?:前置|出餐)：|$)", method, re.S)
            content = clean(m.group(1)) if m else ""
            if content:
                steps.append({"instruction": f"{label}：{content}"})

        notes = []
        std = noodle_standard.get("湯麵" if "湯" in category else "乾拌麵", "")
        for line in lines:
            if line.get("ingredient") == "生麵條" and line["quantity"] and std:
                if str(line["quantity"]) not in re.findall(r"(\d+)\s*g", std):
                    notes.append(f"麵量待確認：菜單試作表寫生麵 {line['quantity']} g，《單份標準》寫「{std}」。")
        for extra in ["試菜結果", "調整方向", "下一輪？", "建議售價", "成本／份", "SOP 編號"]:
            if row.get(extra):
                notes.append(f"{extra}：{clean(row[extra])}")

        recipes.append(
            {
                "name": name,
                "type": "dish",
                "menu_category": category,
                "description": "基準版（第一版試作基準，需經實際試菜校正）",
                "to_testing": False,
                "version": {
                    "title": "基準版",
                    "change_note": "由《餐廳菜單_完整試作與配方表》匯入",
                    "serving_qty": None,
                    "serving_unit": "g",
                    "notes": "\n".join(notes),
                    "lines": lines,
                    "steps": steps,
                },
            }
        )
    return recipes


def flag_name_mismatch(dishes: list[dict], registry: Registry) -> None:
    """菜名提到某個原物料，用料裡卻沒有：多半是複製列之後沒改到"""
    known = set(registry.items) | set(ALIASES)
    for dish in dishes:
        used = [line.get("ingredient") or line.get("component") or "" for line in dish["version"]["lines"]]
        missing = []
        for word in sorted(known, key=len, reverse=True):
            if word not in dish["name"] or any(word in m for m in missing):
                continue
            canonical = ALIASES.get(word, (word, ""))[0]
            if not any(canonical in u or word in u for u in used):
                missing.append(word)
        if missing and used:
            note = f"資料疑點：菜名提到「{'」「'.join(missing)}」，但用料裡沒有，可能是複製列之後沒有改到，請確認。"
            v = dish["version"]
            v["notes"] = chr(10).join(x for x in [note, v["notes"]] if x)


def main() -> None:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    registry = Registry()
    dishes = build_dishes(wb["菜單試作表"], wb["單份標準"], registry)
    soups = build_soups(wb["基底湯食譜"], registry, dishes)
    flag_name_mismatch(dishes, registry)
    recipes = soups + dishes
    data = {
        "source": xlsx.name,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "ingredients": sorted(registry.items.values(), key=lambda x: (x["category"], x["name"])),
        "recipes": recipes,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"輸出 {out}")
    print(f"原物料 {len(registry.items)} 項、元件 {len(soups)} 個、菜品 {len(dishes)} 道")


if __name__ == "__main__":
    main()
