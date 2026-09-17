import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './harness';
import { createIngredient, createRecipe, expectError, saveDraft } from './fixtures';

let t: TestDb;
let ingredientId: string;
let specId: string;
let recipeId: string;
let versionId: string;

beforeAll(async () => {
  t = await createTestDb();
  const ing = await createIngredient(t, { name: '鹽', packQty: 1, packUnit: 'kg', price: 30 });
  ingredientId = ing.id;
  specId = ing.specId!;
  const r = await createRecipe(t, { type: 'dish', name: '測試湯麵' });
  recipeId = r.recipeId;
  versionId = r.versionId;
  await saveDraft(t, versionId, { serving: [500, 'g'], lines: [{ line_kind: 'ingredient', ingredient_id: ingredientId, quantity: 2, unit: 'g' }] });
});

const READS_FOR_KITCHEN_ROLES: Array<[string, () => Record<string, unknown>]> = [
  ['get_settings', () => ({})],
  ['list_units', () => ({})],
  ['list_ingredients', () => ({})],
  ['get_ingredient', () => ({ p_id: ingredientId })],
  ['list_suppliers', () => ({})],
  ['list_recipes', () => ({})],
  ['get_recipe', () => ({ p_id: recipeId })],
  ['get_version', () => ({ p_id: versionId })],
  ['get_costing_bundle', () => ({ p_version_ids: [versionId] })],
  ['list_tasting_sessions', () => ({})],
  ['list_team_members', () => ({})],
];

describe('讀取權限', () => {
  it.each(READS_FOR_KITCHEN_ROLES)('%s：創辦人、主廚、店長可以讀；測試人員與待審核不行', async (fn, args) => {
    for (const role of ['founder', 'chef', 'manager'] as const) {
      await expect(t.rpc(t.users[role], fn, args())).resolves.toBeDefined();
    }
    for (const role of ['tester', 'pending'] as const) {
      await expectError(t.rpc(t.users[role], fn, args()), '權限不足');
    }
    await expectError(t.rpc(null, fn, args()), '請先登入');
  });

  it('待審核帳號連首頁與試菜任務都不能讀', async () => {
    await expectError(t.rpc(t.users.pending, 'get_dashboard'), '權限不足');
    await expectError(t.rpc(t.users.pending, 'get_my_tasting_tasks'), '權限不足');
    const me = await t.rpc<{ role: string }>(t.users.pending, 'me');
    expect(me.role).toBe('pending');
  });

  it('測試人員的首頁只有試菜任務數，沒有成本或食譜資料', async () => {
    const d = await t.rpc<Record<string, unknown>>(t.users.tester, 'get_dashboard');
    expect(Object.keys(d).sort()).toEqual(['my_open_tasting_tasks', 'role']);
  });

  it('只有創辦人可以看帳號清單與全部資料匯出', async () => {
    await expect(t.rpc(t.users.founder, 'list_profiles')).resolves.toHaveLength(7);
    await expect(t.rpc(t.users.founder, 'export_all')).resolves.toHaveProperty('tables');
    for (const role of ['chef', 'manager', 'tester'] as const) {
      await expectError(t.rpc(t.users[role], 'list_profiles'), '權限不足');
      await expectError(t.rpc(t.users[role], 'export_all'), '權限不足');
    }
  });

  it('操作紀錄：創辦人全部、主廚只看食譜與原物料相關、其他角色不行', async () => {
    const founder = await t.rpc<{ items: Array<{ table_name: string }> }>(t.users.founder, 'list_audit_logs', { p: {} });
    expect(founder.items.some((x) => x.table_name === 'profiles')).toBe(true);
    const chef = await t.rpc<{ items: Array<{ table_name: string }> }>(t.users.chef, 'list_audit_logs', { p: {} });
    expect(chef.items.length).toBeGreaterThan(0);
    expect(chef.items.some((x) => x.table_name === 'profiles')).toBe(false);
    await expectError(t.rpc(t.users.manager, 'list_audit_logs', { p: {} }), '權限不足');
    await expectError(t.rpc(t.users.tester, 'list_audit_logs', { p: {} }), '權限不足');
  });
});

describe('寫入權限', () => {
  it('店長可以維護原物料與單價，但不能建立或編輯食譜', async () => {
    await expect(
      t.rpc(t.users.manager, 'upsert_ingredient', { p: { name: '白胡椒', base_dimension: 'mass' } }),
    ).resolves.toBeTypeOf('string');
    await expect(
      t.rpc(t.users.manager, 'add_purchase_price', { p_spec_id: specId, p_price: 32, p_effective_date: '2026-02-01', p_note: '' }),
    ).resolves.toBeTypeOf('string');
    await expectError(t.rpc(t.users.manager, 'create_recipe', { p: { type: 'dish', name: '店長的菜' } }), '權限不足');
    await expectError(
      t.rpc(t.users.manager, 'save_version_draft', { p_version_id: versionId, p_revision: 1, p: {} }),
      '權限不足',
    );
    await expectError(t.rpc(t.users.manager, 'copy_version', { p_source_id: versionId }), '權限不足');
    await expectError(
      t.rpc(t.users.manager, 'transition_version', { p_version_id: versionId, p_to: 'testing', p_comment: '' }),
      '權限不足',
    );
  });

  it('測試人員不能寫入任何主檔', async () => {
    await expectError(t.rpc(t.users.tester, 'upsert_ingredient', { p: { name: 'x', base_dimension: 'mass' } }), '權限不足');
    await expectError(t.rpc(t.users.tester, 'upsert_supplier', { p: { name: 'x' } }), '權限不足');
    await expectError(t.rpc(t.users.tester, 'create_recipe', { p: { type: 'dish', name: 'x' } }), '權限不足');
    await expectError(t.rpc(t.users.tester, 'create_tasting_session', { p: { tasted_on: '2026-09-22', items: [] } }), '權限不足');
  });

  it('只有創辦人可以：設定售價、作廢單價、指派角色、修改設定', async () => {
    for (const role of ['chef', 'manager'] as const) {
      await expectError(
        t.rpc(t.users[role], 'set_menu_price', { p_recipe_id: recipeId, p_price: 150, p_effective_date: '2026-09-01', p_note: '' }),
        '權限不足',
      );
      await expectError(t.rpc(t.users[role], 'assign_role', { p_user_id: t.users.pending, p_role: 'tester' }), '權限不足');
      await expectError(t.rpc(t.users[role], 'update_settings', { p_patch: { price_round_to: 10 } }), '權限不足');
    }
    const prices = await t.sql<{ id: string }>('select id from app.purchase_prices limit 1');
    await expectError(t.rpc(t.users.chef, 'void_purchase_price', { p_id: prices[0].id, p_reason: '打錯' }), '權限不足');

    await expect(
      t.rpc(t.users.founder, 'set_menu_price', { p_recipe_id: recipeId, p_price: 150, p_effective_date: '2026-09-01', p_note: '' }),
    ).resolves.toBeTypeOf('string');
    await expect(t.rpc(t.users.founder, 'update_settings', { p_patch: { price_round_to: 10 } })).resolves.toMatchObject({
      price_round_to: 10,
    });
    await t.rpc(t.users.founder, 'update_settings', { p_patch: { price_round_to: 5 } });
  });

  it('不能移除最後一位創辦人；不能停用自己', async () => {
    await expectError(t.rpc(t.users.founder, 'assign_role', { p_user_id: t.users.founder, p_role: 'chef' }), '至少要保留一位');
    await expectError(t.rpc(t.users.founder, 'set_profile_active', { p_user_id: t.users.founder, p_active: false }), '不能停用自己');
  });

  it('停用的帳號失去所有權限', async () => {
    await t.rpc(t.users.founder, 'set_profile_active', { p_user_id: t.users.chef2, p_active: false });
    await expectError(t.rpc(t.users.chef2, 'list_recipes'), '權限不足');
    await t.rpc(t.users.founder, 'set_profile_active', { p_user_id: t.users.chef2, p_active: true });
    await expect(t.rpc(t.users.chef2, 'list_recipes')).resolves.toBeDefined();
  });
});

describe('資料庫層防護', () => {
  it('前端角色不能直接讀寫 app schema 的資料表', async () => {
    await expectError(
      t.db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.users.founder })]);
        await tx.query('set local role authenticated');
        await tx.query('select * from app.purchase_prices');
      }),
      'permission denied',
    );
  });

  it('anon 不能執行任何 RPC', async () => {
    await expectError(
      t.db.transaction(async (tx) => {
        await tx.query('set local role anon');
        await tx.query('select public.list_recipes()');
      }),
      'permission denied',
    );
  });

  it('操作紀錄不能修改或刪除（連資料庫擁有者也不行）', async () => {
    await expectError(t.sql(`update app.audit_logs set context = 'x'`), '操作紀錄只能新增');
    await expectError(t.sql(`delete from app.audit_logs`), '操作紀錄只能新增');
  });

  it('單價只增不改：不能修改金額、不能刪除、作廢不能恢復', async () => {
    const [p] = await t.sql<{ id: string }>('select id from app.purchase_prices limit 1');
    await expectError(t.sql(`update app.purchase_prices set price = 1 where id = $1`, [p.id]), '單價紀錄不能修改');
    await expectError(t.sql(`delete from app.purchase_prices where id = $1`, [p.id]), '單價紀錄不能刪除');
    await t.rpc(t.users.founder, 'void_purchase_price', { p_id: p.id, p_reason: '測試作廢' });
    await expectError(t.sql(`update app.purchase_prices set is_void = false where id = $1`, [p.id]), '已作廢的單價不能恢復');
  });
});
