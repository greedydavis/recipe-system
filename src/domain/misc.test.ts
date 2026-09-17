import { describe, expect, it } from 'vitest';
import { D, dec } from './decimal';
import { diffLines, diffSteps } from './diff';
import { altUnitHint, formatPercent, formatQty, formatServingCost, formatUnitCost } from './format';
import { priceMetrics, suggestedPrice } from './pricing';
import { scaleFactor } from './scaling';
import { STATUSES, availableTransitions, transitionRoles } from './status';
import { DEFAULT_SETTINGS, version } from './__fixtures__/builders';

describe('售價與毛利', () => {
  it('建議售價剛好是 5 的倍數時不再進位', () => {
    // 35 ÷ 0.35 × 1.05 = 105
    expect(suggestedPrice(dec(35), 0.35, 0.05, 5).toString()).toBe('105');
    expect(suggestedPrice(dec('35.0001'), 0.35, 0.05, 5).toString()).toBe('110');
  });

  it('稅率 0% 與 5%', () => {
    const v = { menu_price: { price: 100 }, target_food_cost_rate: null };
    const noTax = priceMetrics(dec(30), v, { ...DEFAULT_SETTINGS, sales_tax_rate: 0 });
    expect(noTax.foodCostRate?.toString()).toBe('0.3');
    expect(noTax.suggestedPrice?.toString()).toBe('90');
    const tax = priceMetrics(dec(30), v, DEFAULT_SETTINGS);
    expect(tax.foodCostRate?.toFixed(4)).toBe('0.3150');
    expect(tax.overTarget).toBe(false);
  });

  it('菜品自訂目標成本率優先於系統設定', () => {
    const m = priceMetrics(dec(30), { menu_price: { price: 100 }, target_food_cost_rate: 0.3 }, DEFAULT_SETTINGS);
    expect(m.targetRate.toString()).toBe('0.3');
    expect(m.overTarget).toBe(true);
  });

  it('成本不完整時不計算毛利與建議售價', () => {
    const m = priceMetrics(null, { menu_price: { price: 100 }, target_food_cost_rate: null }, DEFAULT_SETTINGS);
    expect(m.foodCostRate).toBeNull();
    expect(m.grossMarginRate).toBeNull();
    expect(m.suggestedPrice).toBeNull();
  });

  it('沒有售價時仍可算建議售價', () => {
    const m = priceMetrics(dec(20), { menu_price: null, target_food_cost_rate: null }, DEFAULT_SETTINGS);
    expect(m.foodCostRate).toBeNull();
    expect(m.suggestedPrice?.toString()).toBe('60');
  });

  it('浮點數陷阱：0.1 + 0.2、1/3 × 3', () => {
    expect(dec(0.1).add(dec(0.2)).toString()).toBe('0.3');
    expect(new D(1).div(3).mul(3).toDecimalPlaces(10).toString()).toBe('1');
  });
});

describe('份量換算', () => {
  const soup = version({ name: '高湯', type: 'component', batch: [10000, 'ml'], serving: [400, 'ml'], lines: [] });
  const noodleDish = version({ name: '湯麵', type: 'dish', serving: [650, 'g'], lines: [] });

  it('1 份、10 份、1 批次、自訂產量', () => {
    const one = scaleFactor(soup, { kind: 'servings', servings: 1 });
    expect(one.ok && one.value.toString()).toBe('0.04');
    const ten = scaleFactor(soup, { kind: 'servings', servings: 10 });
    expect(ten.ok && ten.value.toString()).toBe('0.4');
    const batch = scaleFactor(soup, { kind: 'batches', batches: 1 });
    expect(batch.ok && batch.value.toString()).toBe('1');
    const out = scaleFactor(soup, { kind: 'output', qty: 25, unit: 'ml' });
    expect(out.ok && out.value.toString()).toBe('0.0025');
    expect(scaleFactor(noodleDish, { kind: 'servings', servings: 10 }).ok).toBe(true);
  });

  it('跨質量容量需要成品密度；份數必須大於 0', () => {
    expect(scaleFactor(soup, { kind: 'output', qty: 1000, unit: 'g' }).ok).toBe(false);
    expect(scaleFactor(soup, { kind: 'servings', servings: 0 }).ok).toBe(false);
    const empty = version({ name: '空', type: 'component', batch: null, serving: null, lines: [] });
    expect(scaleFactor(empty, { kind: 'batches', batches: 1 }).ok).toBe(false);
  });
});

describe('顯示進位', () => {
  it('g、ml：小於 10 到小數 1 位，10 以上整數；9.95 不會顯示成 10.0', () => {
    expect(formatQty(dec('9.94'), 'g')).toBe('9.9');
    expect(formatQty(dec('9.95'), 'g')).toBe('10');
    expect(formatQty(dec('0.5'), 'g')).toBe('0.5');
    expect(formatQty(dec('5'), 'ml')).toBe('5');
    expect(formatQty(dec('999.5'), 'g')).toBe('1,000');
    expect(formatQty(dec('14285.714'), 'g')).toBe('14,286');
  });

  it('計數單位到小數 1 位；kg、L、台斤到小數 2 位', () => {
    expect(formatQty(dec('0.05'), '顆')).toBe('0.1');
    expect(formatQty(dec('3'), 'pc')).toBe('3');
    expect(formatQty(dec('1.428571'), 'kg')).toBe('1.43');
    expect(formatQty(null, 'g')).toBe('—');
  });

  it('金額與百分比', () => {
    expect(formatUnitCost(dec('0.066666667'))).toBe('0.0667');
    expect(formatServingCost(dec('13.15'))).toBe('13.2');
    expect(formatPercent(dec('0.31784'))).toBe('31.8%');
    expect(altUnitHint(dec(14285.7), 'g')).toBe('14.29 kg');
    expect(altUnitHint(dec(999), 'ml')).toBeNull();
  });
});

describe('狀態轉移表', () => {
  it('只有創辦人能核准、退回與停用已定版', () => {
    expect(transitionRoles('pending_approval', 'locked')).toEqual(['founder']);
    expect(transitionRoles('locked', 'retired')).toEqual(['founder']);
    expect(transitionRoles('draft', 'testing')).toEqual(['founder', 'chef']);
  });

  it('停用是終點；不存在的轉移回傳 null', () => {
    for (const to of STATUSES) expect(transitionRoles('retired', to)).toBeNull();
    expect(transitionRoles('locked', 'draft')).toBeNull();
    expect(transitionRoles('draft', 'locked')).toBeNull();
  });

  it('店長與測試人員沒有任何轉移', () => {
    for (const from of STATUSES) {
      expect(availableTransitions(from, 'manager')).toEqual([]);
      expect(availableTransitions(from, 'tester')).toEqual([]);
    }
  });
});

describe('版本比較', () => {
  const line = (id: string, name: string, qty: number | null, unit = 'g', extra = {}) => ({
    line_kind: 'ingredient' as const,
    ingredient_id: id,
    ingredient_name: name,
    quantity: qty,
    unit,
    waste_rate_override: null,
    ...extra,
  });

  it('標示新增、刪除、修改與數量差', () => {
    const a = [line('bone', '豬大骨', 1800), line('ginger', '薑', 80), line('salt', '鹽', 5)];
    const b = [line('bone', '豬大骨', 2000), line('ginger', '薑', 80), line('scallop', '干貝', 100)];
    const d = diffLines(a, b);
    const byName = Object.fromEntries(d.map((x) => [x.name, x]));
    expect(byName['豬大骨'].change).toBe('changed');
    expect(byName['豬大骨'].qtyDelta?.toString()).toBe('200');
    expect(byName['豬大骨'].qtyRatio?.toFixed(4)).toBe('0.1111');
    expect(byName['薑'].change).toBe('same');
    expect(byName['鹽'].change).toBe('removed');
    expect(byName['干貝'].change).toBe('added');
  });

  it('單位不同時不計算數量差；同一原物料出現兩次依順序配對', () => {
    const d = diffLines(
      [line('scallion', '青蔥', 10), line('scallion', '青蔥', 5)],
      [line('scallion', '青蔥', 1, 'kg'), line('scallion', '青蔥', 5)],
    );
    expect(d[0].change).toBe('changed');
    expect(d[0].qtyDelta).toBeNull();
    expect(d[1].change).toBe('same');
  });

  it('步驟比較', () => {
    const s = (n: number, text: string, min: number | null) => ({
      step_no: n,
      instruction: text,
      duration_minutes: min,
      temperature_c: null,
      heat_level: null,
      is_critical: false,
    });
    const d = diffSteps([s(1, '汆燙', 5), s(2, '小滾', 240)], [s(1, '汆燙', 8)]);
    expect(d[0]).toMatchObject({ change: 'changed', changedFields: ['時間'] });
    expect(d[1].change).toBe('removed');
  });
});
