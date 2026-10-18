import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './harness';
import { createIngredient, expectError } from './fixtures';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

interface Spec {
  id: string;
  spec_name: string;
  pack_qty: number;
  pack_unit: string;
  is_default: boolean;
  is_active: boolean;
  supplier_id: string | null;
  prices: Array<{ price: number; effective_date: string; note: string; is_void: boolean }>;
}
type Result = { added: number; skipped: number; created_specs: number };

const batch = (user: string, p: Record<string, unknown>) => t.rpc<Result>(user, 'batch_add_purchase_prices', { p });
const specs = async (ingredientId: string) =>
  (await t.rpc<{ specs: Spec[] }>(t.users.chef, 'get_ingredient', { p_id: ingredientId })).specs;
const unitCost = async (ingredientId: string) => {
  const list = await t.rpc<Array<{ id: string; default_spec: { pack_qty: number; price: { price: number } | null } | null }>>(
    t.users.chef,
    'list_ingredients',
    { p_include_inactive: true },
  );
  const spec = list.find((i) => i.id === ingredientId)!.default_spec!;
  return Number(spec.price!.price) / Number(spec.pack_qty);
};

describe('批次輸入單價', () => {
  it('沒有規格時建立並設為預設；同樣包裝沿用既有規格；不同包裝建立新規格並改成預設', async () => {
    const bone = await createIngredient(t, { name: '批次骨' });
    const salt = await createIngredient(t, { name: '批次鹽', packQty: 1, packUnit: 'kg', price: 30 });
    const egg = await createIngredient(t, { name: '批次蛋', base: 'count' });
    const supplier = await t.rpc<string>(t.users.chef, 'upsert_supplier', { p: { name: '批次供應商' } });

    const first = await batch(t.users.manager, {
      effective_date: '2026-10-18',
      supplier_id: supplier,
      note: '10 月報價',
      items: [
        { ingredient_id: bone.id, pack_qty: 20, pack_unit: 'kg', price: 1200 },
        { ingredient_id: salt.id, pack_qty: 1, pack_unit: 'kg', price: 35 },
        { ingredient_id: egg.id, pack_qty: 30, pack_unit: 'pc', price: 150 },
      ],
    });
    expect(first).toEqual({ added: 3, skipped: 0, created_specs: 2 });

    const [boneSpec] = await specs(bone.id);
    expect(boneSpec).toMatchObject({ spec_name: '20 kg', pack_unit: 'kg', is_default: true, supplier_id: supplier });
    expect(boneSpec.prices[0]).toMatchObject({ effective_date: '2026-10-18', note: '10 月報價' });
    expect((await specs(egg.id))[0].spec_name).toBe('30 個');
    // 鹽：沿用原本的 1 kg 規格，多一筆單價，成本用新的價格
    const saltSpecs = await specs(salt.id);
    expect(saltSpecs).toHaveLength(1);
    expect(saltSpecs[0].prices.map((p) => Number(p.price)).sort()).toEqual([30, 35]);
    expect(await unitCost(salt.id)).toBe(35);

    // 換成 5 kg 包裝：建立新規格並改成預設，舊規格保留
    await batch(t.users.chef, { effective_date: '2026-10-18', items: [{ ingredient_id: salt.id, pack_qty: 5, pack_unit: 'kg', price: 150 }] });
    const after = await specs(salt.id);
    expect(after).toHaveLength(2);
    expect(after.find((s) => Number(s.pack_qty) === 5)).toMatchObject({ is_default: true, spec_name: '5 kg' });
    expect(after.find((s) => Number(s.pack_qty) === 1)).toMatchObject({ is_default: false, is_active: true });
    expect(await unitCost(salt.id)).toBe(30);

    // 又回到 1 kg：沿用舊規格並改回預設
    await batch(t.users.chef, { effective_date: '2026-10-19', items: [{ ingredient_id: salt.id, pack_qty: 1, pack_unit: 'kg', price: 32 }] });
    expect((await specs(salt.id)).find((s) => s.is_default)?.pack_qty).toBe(1);
  });

  it('按兩次儲存不會重複記；任一筆有問題整批都不寫入', async () => {
    const pork = await createIngredient(t, { name: '批次肉' });
    const fish = await createIngredient(t, { name: '批次魚' });
    const items = [{ ingredient_id: pork.id, pack_qty: 1, pack_unit: '台斤', price: 180 }];
    expect(await batch(t.users.chef, { effective_date: '2026-10-18', items })).toMatchObject({ added: 1 });
    expect(await batch(t.users.chef, { effective_date: '2026-10-18', items })).toEqual({ added: 0, skipped: 1, created_specs: 0 });

    await expectError(
      batch(t.users.chef, {
        effective_date: '2026-10-18',
        items: [
          { ingredient_id: fish.id, pack_qty: 1, pack_unit: 'kg', price: 300 },
          { ingredient_id: pork.id, pack_qty: 1, pack_unit: '把', price: 10 },
        ],
      }),
      '「批次肉」：單位「把」不適用',
    );
    expect(await specs(fish.id)).toHaveLength(0);

    await expectError(batch(t.users.chef, { effective_date: '2026-10-18', items: [{ ingredient_id: fish.id, pack_qty: 0, pack_unit: 'kg', price: 1 }] }), '包裝數量必須大於 0');
    await expectError(batch(t.users.chef, { effective_date: '2026-10-18', items: [{ ingredient_id: fish.id, pack_qty: 1, pack_unit: 'kg', price: -1 }] }), '金額不能是空的或負數');
    await expectError(batch(t.users.chef, { effective_date: '', items }), '請填寫生效日');
    await expectError(batch(t.users.chef, { effective_date: '2026-10-18', items: [] }), '沒有要儲存的單價');
  });

  it('創辦人、主廚、店長可以用；測試人員與待審核不行；留下操作紀錄', async () => {
    const leaf = await createIngredient(t, { name: '批次菜' });
    const items = [{ ingredient_id: leaf.id, pack_qty: 1, pack_unit: 'kg', price: 60 }];
    for (const role of ['tester', 'pending'] as const) {
      await expectError(batch(t.users[role], { effective_date: '2026-10-18', items }), '權限不足');
    }
    await batch(t.users.founder, { effective_date: '2026-10-18', items });
    const logs = await t.sql<{ table_name: string; context: string }>(
      `select table_name, context from app.audit_logs where context = 'batch_add_purchase_prices' and actor_id = $1`,
      [t.users.founder],
    );
    expect(logs.map((l) => l.table_name).sort()).toEqual(['packaging_specs', 'purchase_prices']);
  });
});
