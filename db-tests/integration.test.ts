import { beforeAll, describe, expect, it } from 'vitest';
import { computeVersionCost } from '../src/domain/costing';
import { priceMetrics } from '../src/domain/pricing';
import { STATUSES, transitionRoles } from '../src/domain/status';
import type { CostingBundle } from '../src/domain/types';
import { GLOBAL_UNITS } from '../src/domain/units';
import { expected } from '../src/domain/__fixtures__/golden/signature-noodle';
import { type TestDb, createTestDb } from './harness';
import { createIngredient, createRecipe, saveDraft, transition } from './fixtures';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

describe('前端與資料庫的規則一致', () => {
  it('系統單位表和 src/domain/units.ts 相同', async () => {
    const rows = await t.sql<{ code: string; name_zh: string; dimension: string; factor_to_base: string; sort_order: number }>(
      'select code, name_zh, dimension, factor_to_base::text, sort_order from app.units order by sort_order',
    );
    expect(rows).toEqual(GLOBAL_UNITS);
  });

  it('狀態轉移角色表和 src/domain/status.ts 相同', async () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const [row] = await t.sql<{ roles: string[] | null }>('select app.transition_roles($1, $2) as roles', [from, to]);
        expect(row.roles, `${from} → ${to}`).toEqual(transitionRoles(from, to));
      }
    }
  });
});

describe('有效單價', () => {
  it('未來生效的價格與作廢的價格都不會被使用', async () => {
    const { id, specId } = await createIngredient(t, { name: '高麗菜', packQty: 1, packUnit: 'kg', price: 100, effectiveDate: '2026-01-01' });
    await t.rpc(t.users.chef, 'add_purchase_price', { p_spec_id: specId, p_price: 999, p_effective_date: '2099-01-01', p_note: '明年' });
    let ing = await t.rpc<{ default_spec: { price: { price: number } } }>(t.users.chef, 'get_ingredient', { p_id: id });
    expect(ing.default_spec.price.price).toBe(100);

    const newer = await t.rpc<string>(t.users.chef, 'add_purchase_price', {
      p_spec_id: specId,
      p_price: 120,
      p_effective_date: '2026-06-01',
      p_note: '',
    });
    ing = await t.rpc(t.users.chef, 'get_ingredient', { p_id: id });
    expect(ing.default_spec.price.price).toBe(120);

    await t.rpc(t.users.founder, 'void_purchase_price', { p_id: newer, p_reason: '打錯' });
    ing = await t.rpc(t.users.chef, 'get_ingredient', { p_id: id });
    expect(ing.default_spec.price.price).toBe(100);

    const bundle = await t.rpc<CostingBundle>(t.users.chef, 'get_costing_bundle', { p_version_ids: [], p_as_of: '2099-06-01' });
    expect(bundle.as_of).toBe('2099-06-01');
  });

  it('第一個包裝規格自動成為預設；改設另一個預設時舊的會取消', async () => {
    const { id, specId } = await createIngredient(t, { name: '花枝', packQty: 1, packUnit: '台斤', price: 90 });
    const second = await t.rpc<string>(t.users.chef, 'upsert_packaging_spec', {
      p: { ingredient_id: id, spec_name: '5 kg/袋', pack_qty: 5, pack_unit: 'kg', is_default: true },
    });
    const ing = await t.rpc<{ specs: Array<{ id: string; is_default: boolean }> }>(t.users.chef, 'get_ingredient', { p_id: id });
    expect(ing.specs.find((s) => s.id === second)?.is_default).toBe(true);
    expect(ing.specs.find((s) => s.id === specId)?.is_default).toBe(false);
  });
});

describe('操作紀錄', () => {
  it('新增、修改、刪除都會記錄操作者、前後值與變動欄位；沒有變動的更新不記錄', async () => {
    const id = await t.rpc<string>(t.users.manager, 'upsert_supplier', { p: { name: '好鮮水產', phone: '04-1234' } });
    await t.rpc(t.users.manager, 'upsert_supplier', { p: { id, name: '好鮮水產', phone: '04-5678' } });
    await t.rpc(t.users.manager, 'upsert_supplier', { p: { id, name: '好鮮水產', phone: '04-5678' } });
    const logs = await t.rpc<{ items: Array<{ action: string; actor_name: string; changed_fields: string[] | null; context: string }> }>(
      t.users.founder,
      'list_audit_logs',
      { p: { table_name: 'suppliers', record_id: id } },
    );
    expect(logs.items.map((x) => x.action)).toEqual(['update', 'insert']);
    expect(logs.items[0]).toMatchObject({ actor_name: '店長', changed_fields: ['phone'], context: 'upsert_supplier' });

    const r = await createRecipe(t, { type: 'dish', name: '紀錄測試菜' });
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: r.versionId });
    await t.rpc(t.users.chef, 'delete_draft', { p_version_id: v2 });
    const del = await t.rpc<{ items: Array<{ action: string; old_data: { version_no: number } }> }>(t.users.founder, 'list_audit_logs', {
      p: { table_name: 'recipe_versions', record_id: v2 },
    });
    expect(del.items[0]).toMatchObject({ action: 'delete', old_data: { version_no: 2 } });
  });
});

describe('RPC 成本資料 + 前端計算 = 黃金範例', () => {
  it('透過資料庫建立黃金範例，計算結果和手算一致', async () => {
    const bone = await createIngredient(t, { name: '黃金豬大骨', packQty: 20, packUnit: 'kg', price: 1200 });
    const onion = await createIngredient(t, { name: '黃金洋蔥', waste: 0.1, packQty: 20, packUnit: 'kg', price: 500 });
    const water = await createIngredient(t, { name: '黃金水', base: 'volume', density: 1, packQty: 1000, packUnit: 'L', price: 12 });
    const noodle = await createIngredient(t, { name: '黃金生麵條', packQty: 3, packUnit: 'kg', price: 180 });
    const scallion = await createIngredient(t, { name: '黃金青蔥', waste: 0.2, packQty: 3, packUnit: 'kg', price: 270 });
    const egg = await createIngredient(t, { name: '黃金雞蛋' });
    await t.rpc(t.users.chef, 'upsert_ingredient_unit', { p: { ingredient_id: egg.id, unit_name: '顆', qty_in_base: 60 } });
    const eggSpec = await t.rpc<string>(t.users.chef, 'upsert_packaging_spec', {
      p: { ingredient_id: egg.id, spec_name: '1 台斤', pack_qty: 1, pack_unit: '台斤' },
    });
    await t.rpc(t.users.chef, 'add_purchase_price', { p_spec_id: eggSpec, p_price: 40, p_effective_date: '2026-01-01', p_note: '' });

    const soup = await createRecipe(t, { type: 'component', name: '黃金湯底' });
    await saveDraft(t, soup.versionId, {
      batch: [21000, 'g'],
      serving: [420, 'g'],
      lines: [
        { line_kind: 'ingredient', ingredient_id: bone.id, quantity: 10000, unit: 'g' },
        { line_kind: 'ingredient', ingredient_id: onion.id, quantity: 2000, unit: 'g' },
        { line_kind: 'ingredient', ingredient_id: water.id, quantity: 30, unit: 'L' },
      ],
    });
    await transition(t, t.users.chef, soup.versionId, 'testing');

    const dish = await createRecipe(t, { type: 'dish', name: '黃金湯麵' });
    await saveDraft(t, dish.versionId, {
      serving: [640, 'g'],
      lines: [
        { line_kind: 'component', component_version_id: soup.versionId, quantity: 420, unit: 'g' },
        { line_kind: 'ingredient', ingredient_id: noodle.id, quantity: 150, unit: 'g' },
        { line_kind: 'ingredient', ingredient_id: scallion.id, quantity: 10, unit: 'g' },
        { line_kind: 'ingredient', ingredient_id: egg.id, quantity: 1, unit: '顆' },
      ],
    });
    await t.rpc(t.users.founder, 'set_menu_price', { p_recipe_id: dish.recipeId, p_price: 90, p_effective_date: '2026-01-01', p_note: '' });

    const bundle = await t.rpc<CostingBundle>(t.users.manager, 'get_costing_bundle', { p_version_ids: [dish.versionId] });
    expect(Object.keys(bundle.versions)).toHaveLength(2);

    const soupCost = computeVersionCost(bundle, soup.versionId);
    expect(soupCost.batchCost?.toFixed(10)).toBe(expected.soup.batchCost);
    expect(soupCost.yieldRate?.toFixed(10)).toBe(expected.soup.yieldRate);

    const dishCost = computeVersionCost(bundle, dish.versionId);
    expect(dishCost.servingCost?.toFixed(10)).toBe(expected.dish.servingCost);
    const m = priceMetrics(dishCost.servingCost, bundle.versions[dish.versionId], bundle.settings);
    expect(m.foodCostRate?.toFixed(10)).toBe(expected.dish.foodCostRate);
    expect(m.suggestedPrice?.toString()).toBe(expected.dish.suggestedPrice);
  });
});
