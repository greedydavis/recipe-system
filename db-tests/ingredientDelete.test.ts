import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './harness';
import { createIngredient, createRecipe, expectError, saveDraft } from './fixtures';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

describe('刪除原物料', () => {
  it('沒用過的可以刪，包裝規格與單價一起刪除並留下操作紀錄', async () => {
    const ing = await createIngredient(t, { name: '打錯的原料', packQty: 1, packUnit: 'kg', price: 10 });
    await t.rpc(t.users.manager, 'delete_ingredient', { p_id: ing.id });
    const [{ n }] = await t.sql<{ n: number }>(
      `select (select count(*) from app.ingredients where id = $1) + (select count(*) from app.packaging_specs where ingredient_id = $1) as n`,
      [ing.id],
    );
    expect(Number(n)).toBe(0);
    const logs = await t.sql<{ table_name: string }>(
      `select distinct table_name from app.audit_logs where action = 'delete' and context = 'delete_ingredient' order by 1`,
    );
    expect(logs.map((l) => l.table_name)).toEqual(['ingredients', 'packaging_specs', 'purchase_prices']);
  });

  it('食譜用過的不能刪（草案也算），錯誤訊息列出是哪個食譜', async () => {
    const ing = await createIngredient(t, { name: '用過的原料' });
    const r = await createRecipe(t, { type: 'dish', name: '用到它的菜' });
    await saveDraft(t, r.versionId, { serving: [500, 'g'], lines: [{ line_kind: 'ingredient', ingredient_id: ing.id, quantity: null, unit: 'g' }] });
    await expectError(t.rpc(t.users.founder, 'delete_ingredient', { p_id: ing.id }), '「用過的原料」已經用在食譜裡（用到它的菜 v1）');
    const [{ n }] = await t.sql<{ n: number }>('select count(*)::int as n from app.ingredients where id = $1', [ing.id]);
    expect(n).toBe(1);
  });

  it('單價平常還是不能直接刪除', async () => {
    const ing = await createIngredient(t, { name: '保護單價原料', packQty: 1, packUnit: 'kg', price: 10 });
    await expect(t.sql('delete from app.purchase_prices where packaging_spec_id = $1', [ing.specId])).rejects.toThrow('單價紀錄不能刪除');
  });

  it('測試人員、待審核不能刪；不存在的回報找不到', async () => {
    const ing = await createIngredient(t, { name: '權限原料' });
    for (const role of ['tester', 'pending'] as const) {
      await expectError(t.rpc(t.users[role], 'delete_ingredient', { p_id: ing.id }), '權限不足');
    }
    await expectError(t.rpc(t.users.chef, 'delete_ingredient', { p_id: '00000000-0000-0000-0000-000000000000' }), '找不到此原物料');
  });
});
