import { describe, expect, it } from 'vitest';
import { computeVersionCost } from './costing';
import { bundle, compLine, ingLine, ingredient, version } from './__fixtures__/builders';

describe('成本計算：損耗率', () => {
  const make = (waste: number | null, override: number | null = null) => {
    const ing = ingredient({ name: '青蔥', base: 'mass', waste: waste ?? 0, spec: { qty: 1000, unit: 'g', price: 100 } });
    const v = version({ name: '蔥花', type: 'component', batch: [100, 'g'], serving: [10, 'g'], lines: [ingLine(ing, 100, 'g', override)] });
    return computeVersionCost(bundle([v], [ing]), v.id);
  };

  it('0%、20%、95% 損耗', () => {
    expect(make(0).lines[0].cost?.toString()).toBe('10');
    expect(make(0.2).lines[0].purchaseQty?.toString()).toBe('125');
    expect(make(0.2).lines[0].cost?.toString()).toBe('12.5');
    expect(make(0.95).lines[0].cost?.toString()).toBe('200');
  });

  it('用料行可以覆寫預設損耗率', () => {
    expect(make(0.2, 0).lines[0].cost?.toString()).toBe('10');
  });

  it('損耗率 ≥ 100% 或負數時成本不完整', () => {
    const r = make(0, 1);
    expect(r.isComplete).toBe(false);
    expect(r.lines[0].issues[0]).toContain('損耗率');
    expect(make(0, -0.1).isComplete).toBe(false);
  });
});

describe('成本計算：缺價格與不完整', () => {
  it('單價 0 元視為有價格（例如水）', () => {
    const water = ingredient({ name: '水', base: 'volume', density: 1, spec: { qty: 1, unit: 'L', price: 0 } });
    const v = version({ name: '冷泡茶', type: 'dish', serving: [350, 'ml'], lines: [ingLine(water, 350, 'ml')] });
    const c = computeVersionCost(bundle([v], [water]), v.id);
    expect(c.isComplete).toBe(true);
    expect(c.servingCost?.toString()).toBe('0');
  });

  it('沒有價格、沒有預設規格時成本不完整，且不把缺值當 0', () => {
    const a = ingredient({ name: '乾香菇', base: 'mass', spec: { qty: 600, unit: 'g', price: null } });
    const b = ingredient({ name: '蝦米', base: 'mass', spec: null });
    const c1 = ingredient({ name: '鹽', base: 'mass', spec: { qty: 1, unit: 'kg', price: 30 } });
    const v = version({
      name: '測試',
      type: 'dish',
      serving: [100, 'g'],
      lines: [ingLine(a, 5, 'g'), ingLine(b, 5, 'g'), ingLine(c1, 1, 'g')],
    });
    const r = computeVersionCost(bundle([v], [a, b, c1]), v.id);
    expect(r.isComplete).toBe(false);
    expect(r.batchCost).toBeNull();
    expect(r.servingCost).toBeNull();
    expect(r.knownCost.toString()).toBe('0.03');
    expect(r.issues).toEqual(['「乾香菇」沒有有效單價', '「蝦米」沒有預設包裝規格']);
  });

  it('用量待填時成本不完整', () => {
    const salt = ingredient({ name: '鹽', base: 'mass', spec: { qty: 1, unit: 'kg', price: 30 } });
    const v = version({ name: '測試', type: 'dish', serving: [100, 'g'], lines: [ingLine(salt, null, 'g')] });
    const r = computeVersionCost(bundle([v], [salt]), v.id);
    expect(r.isComplete).toBe(false);
    expect(r.issues).toContain('「鹽」用量待填');
  });

  it('單位無法換算時成本不完整', () => {
    const oil = ingredient({ name: '蔥油', base: 'volume', spec: { qty: 1, unit: 'L', price: 200 } });
    const v = version({ name: '測試', type: 'dish', serving: [100, 'g'], lines: [ingLine(oil, 5, 'g')] });
    const r = computeVersionCost(bundle([v], [oil]), v.id);
    expect(r.isComplete).toBe(false);
    expect(r.issues[0]).toContain('沒有設定密度');
  });

  it('沒有用料、沒有產量時成本不完整', () => {
    const v = version({ name: '空白', type: 'component', batch: null, serving: null, lines: [] });
    const r = computeVersionCost(bundle([v], []), v.id);
    expect(r.isComplete).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining(['還沒有任何用料', '批次產量未填', '每份量未填']));
  });
});

describe('成本計算：巢狀元件與出成率', () => {
  const chili = ingredient({ name: '辣椒', base: 'mass', spec: { qty: 1, unit: 'kg', price: 200 } });
  const oil = ingredient({ name: '沙拉油', base: 'volume', density: 0.9, spec: { qty: 1, unit: 'L', price: 90 } });
  const noodle = ingredient({ name: '生麵', base: 'mass', spec: { qty: 1, unit: 'kg', price: 60 } });
  const water = ingredient({ name: '水', base: 'volume', density: 1, spec: { qty: 1000, unit: 'L', price: 12 } });

  // 醬料 → 配料 → 菜品，三層
  const chiliOil = version({
    name: '辣油',
    type: 'component',
    batch: [900, 'g'],
    serving: [10, 'g'],
    lines: [ingLine(chili, 100, 'g'), ingLine(oil, 1, 'L')],
  });
  const topping = version({
    name: '紅油抄手醬',
    type: 'component',
    batch: [500, 'g'],
    serving: [50, 'g'],
    lines: [compLine(chiliOil, 450, 'g'), ingLine(chili, 50, 'g')],
  });
  const cooked = version({
    name: '燙熟麵條',
    type: 'component',
    batch: [2200, 'g'],
    serving: [220, 'g'],
    lines: [ingLine(noodle, 1000, 'g'), ingLine(water, 1.5, 'L')],
  });
  const dish = version({
    name: '紅油拌麵',
    type: 'dish',
    serving: [300, 'g'],
    menuPrice: 150,
    lines: [compLine(topping, 1, '份'), compLine(cooked, 220, 'g')],
  });
  const b = bundle([chiliOil, topping, cooked, dish], [chili, oil, noodle, water]);

  it('三層巢狀元件成本', () => {
    const c1 = computeVersionCost(b, chiliOil.id);
    // 辣椒 100 g × 0.2 = 20；油 1 L × 0.09 = 90 → 110 元 / 900 g
    expect(c1.batchCost?.toString()).toBe('110');
    // 投入：100 g + 1000 ml × 0.9 = 1000 g，產出 900 g → 90%
    expect(c1.yieldRate?.toString()).toBe('0.9');

    const c2 = computeVersionCost(b, topping.id);
    // 辣油 450 g × 110/900 = 55；辣椒 50 g × 0.2 = 10 → 65 元 / 500 g
    expect(c2.batchCost?.toDecimalPlaces(10).toString()).toBe('65');

    const c3 = computeVersionCost(b, dish.id);
    // 1 份醬 = 50 g × 0.13 = 6.5；麵 220 g × (60 + 0.018) / 2200 = 6.0018
    expect(c3.lines[0].cost?.toDecimalPlaces(10).toString()).toBe('6.5');
    expect(c3.lines[1].cost?.toDecimalPlaces(10).toString()).toBe('6.0018');
    expect(c3.servingCost?.toDecimalPlaces(10).toString()).toBe('12.5018');
  });

  it('出成率可以大於 100%（麵條吸水）', () => {
    const c = computeVersionCost(b, cooked.id);
    // 投入 1000 g + 1500 g = 2500 g，產出 2200 g → 88%
    expect(c.yieldRate?.toString()).toBe('0.88');
    const absorbing = version({
      name: '燙麵（只算麵重）',
      type: 'component',
      batch: [220, 'g'],
      serving: [220, 'g'],
      lines: [ingLine(noodle, 150, 'g')],
    });
    const r = computeVersionCost(bundle([absorbing], [noodle]), absorbing.id);
    expect(r.yieldRate?.toFixed(4)).toBe('1.4667');
  });

  it('產量用 ml 但沒有成品密度時不顯示出成率，但不影響成本', () => {
    const soup = version({
      name: '高湯',
      type: 'component',
      batch: [1000, 'ml'],
      serving: [400, 'ml'],
      lines: [ingLine(water, 1.2, 'L')],
    });
    const r = computeVersionCost(bundle([soup], [water]), soup.id);
    expect(r.yieldRate).toBeNull();
    expect(r.isComplete).toBe(true);
    expect(r.servingCost?.toString()).toBe('0.00576');
  });

  it('被引用的元件成本不完整時，上層也不完整', () => {
    const noPrice = ingredient({ name: '酸菜', base: 'mass', spec: null });
    const broken = version({ name: '酸菜料', type: 'component', batch: [100, 'g'], serving: [20, 'g'], lines: [ingLine(noPrice, 100, 'g')] });
    const top = version({ name: '酸菜麵', type: 'dish', serving: [400, 'g'], lines: [compLine(broken, 20, 'g')] });
    const r = computeVersionCost(bundle([broken, top], [noPrice]), top.id);
    expect(r.isComplete).toBe(false);
    expect(r.issues).toContain('元件「酸菜料」v1 成本不完整');
  });
});
