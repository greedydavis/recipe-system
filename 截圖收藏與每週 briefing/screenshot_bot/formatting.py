"""回覆給使用者的文字（Telegram HTML 格式）。所有外來文字都要先 escape。"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from html import escape
from typing import Sequence
from zoneinfo import ZoneInfo

from .ai.base import BriefingDraft
from .db import Item

TELEGRAM_LIMIT = 4096
_WEEKDAY = "一二三四五六日"


def esc(text: str | None) -> str:
    return escape(text or "", quote=False)


def local_time(dt: datetime, tz: ZoneInfo, with_weekday: bool = False) -> str:
    local = dt.astimezone(tz)
    if with_weekday:
        return f"{local:%m/%d}（{_WEEKDAY[local.weekday()]}）{local:%H:%M}"
    return f"{local:%m/%d %H:%M}"


def period_label(start: datetime, end: datetime, tz: ZoneInfo) -> str:
    return f"{local_time(start, tz, True)} – {local_time(end, tz, True)}"


def item_card(item: Item, tz: ZoneInfo, *, header: str) -> str:
    lines = [f"{header} <b>#{item.id}</b>"]
    if item.status == "done":
        lines.append(f"📌 <b>{esc(item.title)}</b>")
        if item.summary:
            lines.append(esc(item.summary))
        meta = f"分類：{esc(item.category)}"
        if item.category_source == "user":
            meta += "（已手動更正）"
        if item.tags:
            meta += "｜標籤：" + " ".join(f"#{esc(t)}" for t in item.tags)
        lines.append(meta)
        if item.todos:
            lines.append("📝 可能的待辦：")
            lines.extend(f"• {esc(t)}" for t in item.todos)
        if item.uncertain:
            lines.append("⚠️ 不確定：" + "；".join(esc(u) for u in item.uncertain))
    elif item.status == "failed":
        lines.append("⚠️ 圖片已安全保存，但 AI 整理暫時失敗：" + esc(item.ai_last_error or "未知原因"))
        if item.ai_next_retry_at:
            lines.append(f"稍後（約 {local_time(item.ai_next_retry_at, tz)}）會自動重試，也可以輸入 /retry {item.id}")
        else:
            lines.append(f"可以輸入 /retry {item.id} 重新整理。")
        if item.category:
            lines.append(f"分類：{esc(item.category)}")
    else:
        lines.append("⏳ AI 整理中…")
    if item.caption:
        lines.append("💬 附言：" + esc(item.caption))
    if item.source_url:
        lines.append("🔗 原文：" + esc(item.source_url))
    return "\n".join(lines)


def item_line(item: Item, tz: ZoneInfo) -> str:
    when = local_time(item.received_at, tz)
    category = f"［{esc(item.category)}］" if item.category else ""
    status = {"failed": " ⚠️未整理", "pending": " ⏳"}.get(item.status, "")
    line = f"<b>#{item.id}</b> {category}{esc(item.display_title)}{status}\n    <i>{when}</i>"
    if item.summary:
        line += f"｜{esc(item.summary)}"
    return line


def item_list(items: Sequence[Item], tz: ZoneInfo, title: str) -> str:
    body = "\n".join(item_line(it, tz) for it in items)
    return f"{title}\n\n{body}\n\n輸入 /get 編號 取回原圖"


def _ids(ids: Sequence[int]) -> str:
    return "、".join(f"#{i}" for i in ids)


def category_counts(items: Sequence[Item]) -> list[tuple[str, int]]:
    counter = Counter(it.category or "未分類" for it in items)
    return counter.most_common()


def render_briefing(
    *,
    items: Sequence[Item],
    draft: BriefingDraft,
    label: str,
    ai_ok: bool,
    preview: bool,
) -> str:
    title = "📰 <b>每週截圖 Briefing</b>" + ("（預覽）" if preview else "")
    counts = "、".join(f"{esc(c)} {n}" for c, n in category_counts(items))
    out = [title, esc(label), f"本週收藏 <b>{len(items)}</b> 則｜{counts}"]
    if preview:
        out.append("<i>這是到目前為止的預覽，不影響正式週報的寄送。</i>")
    if not ai_ok:
        out.append("<i>（AI 綜整暫時無法使用，以下是自動統計版）</i>")
    if draft.overview:
        out += ["", "🧭 <b>本週重點</b>", esc(draft.overview)]
    if draft.themes:
        out += ["", "📚 <b>主要主題</b>"]
        for n, theme in enumerate(draft.themes, 1):
            line = f"{n}. <b>{esc(theme.name)}</b>"
            if theme.summary:
                line += f"：{esc(theme.summary)}"
            if theme.item_ids:
                line += f"（{_ids(theme.item_ids)}）"
            out.append(line)
    if draft.highlights:
        by_id = {it.id: it for it in items}
        out += ["", "⭐ <b>最值得回看</b>"]
        for h in draft.highlights:
            it = by_id[h.item_id]
            line = f"• <b>#{it.id}</b> {esc(it.display_title)}"
            if h.reason:
                line += f" — {esc(h.reason)}"
            out.append(line)
    out += ["", "✅ <b>可以採取的行動</b>"]
    if draft.actions:
        for a in draft.actions:
            line = f"• {esc(a.text)}"
            if a.item_ids:
                line += f"（{_ids(a.item_ids)}）"
            out.append(line)
    else:
        out.append("• 本週沒有明確需要行動的項目，有空再回看即可。")
    unanalyzed = [it.id for it in items if it.status != "done"]
    if unanalyzed:
        out += ["", f"⚠️ 有 {len(unanalyzed)} 則尚未完成 AI 整理（{_ids(unanalyzed)}），可輸入 /retry 重試。"]
    out += ["", "輸入 /get 編號 取回原圖，例如 /get " + str(items[-1].id)]
    return "\n".join(out)


def render_empty_briefing(label: str, preview: bool) -> str:
    title = "📭 <b>每週截圖 Briefing</b>" + ("（預覽）" if preview else "")
    return f"{title}\n{esc(label)}\n本週沒有新收藏。看到想留下的內容，截圖分享給我就好！"


def split_message(text: str, limit: int = TELEGRAM_LIMIT - 96) -> list[str]:
    """依行切段，避免超過 Telegram 單則 4096 字的限制（不會切斷 HTML 標籤所在的行）。"""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > limit:  # 單行過長時硬切（我們產生的行都不會這麼長，只是保險）
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > limit:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks
