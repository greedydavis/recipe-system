import { describe, expect, it } from 'vitest';
import { dec } from './decimal';
import { ingredient, version } from './__fixtures__/builders';
import { ingredientBaseToGrams, toComponentOutputUnit, toIngredientBase } from './units';

const val = (r: ReturnType<typeof toIngredientBase>) => (r.ok ? r.value.toString() : `ERR:${r.issue}`);

describe('原物料單位換算', () => {
  const pork = ingredient({ name: '豬肉', base: 'mass' });
  const soy = ingredient({ name: '醬油', base: 'volume', density: 1.2 });
  const oil = ingredient({ name: '沙拉油', base: 'volume' });
  const egg = ingredient({ name: '雞蛋', base: 'mass', units: [{ unit_name: '顆', qty_in_base: 60 }] });
  const lemon = ingredient({ name: '檸檬', base: 'count', units: [{ unit_name: '片', qty_in_base: 0.125 }] });

  it('同維度的系統單位：kg、台斤、兩、L、大匙、小匙', () => {
    expect(val(toIngredientBase(dec(2), 'kg', pork))).toBe('2000');
    expect(val(toIngredientBase(dec(1.5), '台斤', pork))).toBe('900');
    expect(val(toIngredientBase(dec(4), '兩', pork))).toBe('150');
    expect(val(toIngredientBase(dec(1.5), 'L', soy))).toBe('1500');
    expect(val(toIngredientBase(dec(2), '大匙', soy))).toBe('30');
    expect(val(toIngredientBase(dec(3), '小匙', soy))).toBe('15');
  });

  it('原物料專屬單位優先', () => {
    expect(val(toIngredientBase(dec(3), '顆', egg))).toBe('180');
    expect(val(toIngredientBase(dec(4), '片', lemon))).toBe('0.5');
  });

  it('質量與體積互換需要密度', () => {
    expect(val(toIngredientBase(dec(120), 'g', soy))).toBe('100');
    expect(val(toIngredientBase(dec(100), 'g', oil))).toContain('沒有設定密度');
    const flourByVolume = ingredient({ name: '麵粉', base: 'mass', density: 0.5 });
    expect(val(toIngredientBase(dec(200), 'ml', flourByVolume))).toBe('100');
  });

  it('個數與重量不能直接換算；未知單位回報錯誤而不是猜測', () => {
    expect(val(toIngredientBase(dec(1), 'pc', pork))).toContain('無法把「個數」換算成「重量」');
    expect(val(toIngredientBase(dec(1), '把', pork))).toContain('沒有「把」這個單位');
  });

  it('基本單位換算成公克（出成率用）', () => {
    expect(ingredientBaseToGrams(dec(100), soy)?.toString()).toBe('120');
    expect(ingredientBaseToGrams(dec(100), oil)).toBeNull();
    expect(ingredientBaseToGrams(dec(2), lemon)).toBeNull();
  });
});

describe('元件用量換算成產出單位', () => {
  const soupMl = version({ name: '高湯', type: 'component', batch: [10000, 'ml'], serving: [400, 'ml'], lines: [] });
  const soupMlDensity = version({
    name: '海鮮湯',
    type: 'component',
    batch: [10000, 'ml'],
    serving: [400, 'ml'],
    density: 1.02,
    lines: [],
  });
  const sauceG = version({ name: '醬汁', type: 'component', batch: [2000, 'g'], serving: [30, 'g'], lines: [] });

  it('同單位、L、份', () => {
    const r1 = toComponentOutputUnit(dec(380), 'ml', soupMl);
    const r2 = toComponentOutputUnit(dec(1.5), 'L', soupMl);
    const r3 = toComponentOutputUnit(dec(2), '份', sauceG);
    expect(r1.ok && r1.value.toString()).toBe('380');
    expect(r2.ok && r2.value.toString()).toBe('1500');
    expect(r3.ok && r3.value.toString()).toBe('60');
  });

  it('重量與容量互換需要成品密度', () => {
    const noDensity = toComponentOutputUnit(dec(100), 'g', soupMl);
    expect(noDensity.ok).toBe(false);
    const withDensity = toComponentOutputUnit(dec(102), 'g', soupMlDensity);
    expect(withDensity.ok && withDensity.value.toString()).toBe('100');
  });

  it('不接受計數或湯匙單位', () => {
    expect(toComponentOutputUnit(dec(1), 'pc', sauceG).ok).toBe(false);
    expect(toComponentOutputUnit(dec(1), '大匙', soupMl).ok).toBe(false);
  });
});
