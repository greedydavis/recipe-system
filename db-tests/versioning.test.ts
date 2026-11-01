import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './harness';
import { createIngredient, createRecipe, expectError, saveDraft, transition } from './fixtures';

let t: TestDb;
let bone: string;
let salt: string;
let noPrice: string;

beforeAll(async () => {
  t = await createTestDb();
  bone = (await createIngredient(t, { name: '豬大骨', packQty: 20, packUnit: 'kg', price: 1200 })).id;
  salt = (await createIngredient(t, { name: '鹽', packQty: 1, packUnit: 'kg', price: 30 })).id;
  noPrice = (await createIngredient(t, { name: '乾香菇' })).id;
});

async function soupDraft(name: string) {
  const r = await createRecipe(t, { type: 'component', name });
  await saveDraft(t, r.versionId, {
    batch: [10000, 'ml'],
    serving: [400, 'ml'],
    lines: [{ line_kind: 'ingredient', ingredient_id: bone, quantity: 1800, unit: 'g' }],
    steps: [{ instruction: '汆燙', duration_minutes: 8 }],
  });
  return r;
}

const lock = (versionId: string) => transition(t, t.users.founder, versionId, 'locked');

async function soupLocked(name: string) {
  const r = await soupDraft(name);
  await lock(r.versionId);
  return r;
}

describe('草案編輯與凍結', () => {
  it('草案可以儲存；版本號與 revision 遞增', async () => {
    const r = await createRecipe(t, { type: 'dish', name: '草案測試' });
    const rev = await saveDraft(t, r.versionId, {
      serving: [600, 'g'],
      lines: [{ line_kind: 'ingredient', ingredient_id: salt, quantity: 2, unit: 'g' }],
    });
    expect(rev).toBe(2);
    const v = await t.rpc<{ version_no: number; lines: unknown[]; batch_output_qty: number }>(t.users.manager, 'get_version', {
      p_id: r.versionId,
    });
    expect(v.version_no).toBe(1);
    expect(v.lines).toHaveLength(1);
    // 菜品的批次產量自動等於每份量
    expect(v.batch_output_qty).toBe(600);
  });

  it('樂觀鎖：用舊的 revision 儲存會被拒絕', async () => {
    const r = await createRecipe(t, { type: 'dish', name: '衝突測試' });
    await t.rpc(t.users.chef, 'save_version_draft', { p_version_id: r.versionId, p_revision: 1, p: { serving_qty: 1 } });
    await expectError(
      t.rpc(t.users.chef2, 'save_version_draft', { p_version_id: r.versionId, p_revision: 1, p: { serving_qty: 2 } }),
      '已經被其他人更新',
    );
  });

  it('草案可以有「用量待填」的行，但定版時會被擋下', async () => {
    const r = await createRecipe(t, { type: 'dish', name: '待填測試' });
    await saveDraft(t, r.versionId, {
      serving: [500, 'g'],
      lines: [{ line_kind: 'ingredient', ingredient_id: salt, quantity: null, unit: 'g' }],
    });
    await expectError(lock(r.versionId), '「鹽」用量待填');
  });

  it('非草案版本的內容，用 RPC 或直接 SQL 都不能修改', async () => {
    const soup = await soupLocked('凍結測試湯');
    await expectError(
      t.rpc(t.users.chef, 'save_version_draft', { p_version_id: soup.versionId, p_revision: 2, p: {} }),
      '內容已凍結',
    );
    await expectError(t.sql(`update app.recipe_versions set serving_qty = 1 where id = $1`, [soup.versionId]), '內容已凍結');
    await expectError(t.sql(`update app.recipe_lines set quantity = 1 where version_id = $1`, [soup.versionId]), '內容已凍結');
    await expectError(t.sql(`delete from app.recipe_lines where version_id = $1`, [soup.versionId]), '內容已凍結');
    await expectError(
      t.sql(`insert into app.recipe_lines (version_id, line_kind, ingredient_id, quantity, unit) values ($1, 'ingredient', $2, 1, 'g')`, [
        soup.versionId,
        salt,
      ]),
      '內容已凍結',
    );
    await expectError(t.sql(`update app.recipe_steps set instruction = 'x' where version_id = $1`, [soup.versionId]), '內容已凍結');
    await expectError(t.sql(`update app.recipe_versions set title = 'x' where id = $1`, [soup.versionId]), '內容已凍結');
    await expectError(t.sql(`update app.recipe_versions set notes = 'x' where id = $1`, [soup.versionId]), '內容已凍結');
    await expectError(
      t.sql(`insert into app.photos (storage_path, version_id) values ('x.webp', $1)`, [soup.versionId]),
      '內容已凍結',
    );
    await expectError(t.sql(`delete from app.recipe_versions where id = $1`, [soup.versionId]), '只有草案可以刪除');
  });

  it('資料庫層也擋下轉移表以外的狀態變更', async () => {
    const soup = await soupDraft('狀態防護湯');
    await expectError(t.sql(`update app.recipe_versions set status = 'testing' where id = $1`, [soup.versionId]), '不允許的狀態轉移');
    await expectError(t.sql(`update app.recipe_versions set status = 'retired' where id = $1`, [soup.versionId]), '不允許的狀態轉移');
    await expectError(
      t.sql(`insert into app.recipe_versions (recipe_id, version_no, status) values ($1, 99, 'locked')`, [soup.recipeId]),
      '新版本一律從草案開始',
    );
  });
});

describe('狀態轉移', () => {
  it('只有創辦人能定版；舊的試菜、核准狀態都不能再用', async () => {
    const soup = await soupDraft('權限測試湯');
    await expectError(transition(t, t.users.chef, soup.versionId, 'locked'), '權限不足');
    await expectError(transition(t, t.users.manager, soup.versionId, 'locked'), '權限不足');
    await expectError(transition(t, t.users.founder, soup.versionId, 'testing'), '不允許的狀態轉移');
    await expectError(transition(t, t.users.founder, soup.versionId, 'pending_approval'), '不允許的狀態轉移');
    await expectError(transition(t, t.users.founder, soup.versionId, 'retired', '不要了'), '不允許的狀態轉移');
  });

  it('定版前要填齊：用料、用量、菜品的每份克重、元件的批次產量與每份量', async () => {
    const empty = await createRecipe(t, { type: 'dish', name: '空白菜' });
    await expectError(lock(empty.versionId), '至少要有 1 行用料');

    const dish = await createRecipe(t, { type: 'dish', name: '沒克重菜' });
    await t.rpc(t.users.chef, 'save_version_draft', {
      p_version_id: dish.versionId,
      p_revision: 1,
      p: { lines: [{ id: crypto.randomUUID(), line_kind: 'ingredient', ingredient_id: salt, quantity: 1, unit: 'g' }] },
    });
    await expectError(lock(dish.versionId), '請填寫每份克重');

    const soup = await createRecipe(t, { type: 'component', name: '沒產量湯' });
    await t.rpc(t.users.chef, 'save_version_draft', {
      p_version_id: soup.versionId,
      p_revision: 1,
      p: { lines: [{ id: crypto.randomUUID(), line_kind: 'ingredient', ingredient_id: bone, quantity: 1800, unit: 'g' }] },
    });
    await expectError(lock(soup.versionId), /請填寫批次產量.*請填寫每份量/);
  });

  it('成本不完整也可以定版：快照記錄 is_complete = false，之後補上單價就算得出成本', async () => {
    const d = await createRecipe(t, { type: 'dish', name: '缺價格菜' });
    await saveDraft(t, d.versionId, {
      serving: [100, 'g'],
      lines: [
        { line_kind: 'ingredient', ingredient_id: noPrice, quantity: 1, unit: 'g' },
        { line_kind: 'ingredient', ingredient_id: salt, quantity: 10, unit: 'g' },
      ],
    });
    await expect(lock(d.versionId)).resolves.toMatchObject({ status: 'locked' });
    const v = await t.rpc<{ snapshots: Array<{ is_complete: boolean; cost_per_serving: number | null }> }>(t.users.chef, 'get_version', {
      p_id: d.versionId,
    });
    expect(v.snapshots).toHaveLength(1);
    expect(v.snapshots[0]).toMatchObject({ is_complete: false, cost_per_serving: null });
  });

  it('成本快照由資料庫重算', async () => {
    const soup = await soupLocked('定版測試湯');
    const v = await t.rpc<{
      status: string;
      approved_by_name: string;
      snapshots: Array<{ batch_cost: number; cost_per_serving: number; is_complete: boolean }>;
      history: Array<{ to_status: string }>;
    }>(t.users.chef, 'get_version', { p_id: soup.versionId });
    expect(v.status).toBe('locked');
    expect(v.approved_by_name).toBe('創辦人');
    expect(v.snapshots).toHaveLength(1);
    expect(v.snapshots[0].is_complete).toBe(true);
    expect(v.snapshots[0].batch_cost).toBe(108);
    expect(v.snapshots[0].cost_per_serving).toBeCloseTo(4.32, 10);
    expect(v.history[0].to_status).toBe('locked');
  });

  it('新版本定版時，舊定版自動停用並記錄被取代', async () => {
    const soup = await soupLocked('取代測試湯');

    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId, p_change_note: '大骨增量' });
    await lock(v2);

    const old = await t.rpc<{ status: string; superseded_by_version_no: number; retire_reason: string }>(t.users.chef, 'get_version', {
      p_id: soup.versionId,
    });
    expect(old.status).toBe('retired');
    expect(old.superseded_by_version_no).toBe(2);
    expect(old.retire_reason).toBe('被 v2 取代');
    const [{ n }] = await t.sql<{ n: number }>(
      `select count(*)::int as n from app.recipe_versions where recipe_id = $1 and status = 'locked'`,
      [soup.recipeId],
    );
    expect(n).toBe(1);
  });

  it('停用是終點；已定版只有創辦人能停用', async () => {
    const soup = await soupLocked('停用測試湯');
    await expectError(transition(t, t.users.chef, soup.versionId, 'retired', '不用了'), '權限不足');
    await transition(t, t.users.founder, soup.versionId, 'retired', '不用了');
    await expectError(transition(t, t.users.founder, soup.versionId, 'locked'), '不允許的狀態轉移');
  });
});

describe('元件引用', () => {
  it('資料庫層拒絕間接循環引用', async () => {
    const a = await createRecipe(t, { type: 'component', name: '循環元件甲' });
    const b = await createRecipe(t, { type: 'component', name: '循環元件乙' });
    // 直接 SQL 模擬繞過前端／RPC；草案狀態下凍結 trigger 不會擋，必須由循環 trigger 擋下。
    await t.sql(
      `insert into app.recipe_lines (version_id, line_kind, component_version_id, quantity, unit) values ($1, 'component', $2, 1, 'g')`,
      [a.versionId, b.versionId],
    );
    await expectError(
      t.sql(
        `insert into app.recipe_lines (version_id, line_kind, component_version_id, quantity, unit) values ($1, 'component', $2, 1, 'g')`,
        [b.versionId, a.versionId],
      ),
      '形成循環',
    );
  });

  it('草案可以引用草案；不能引用自己的食譜或已停用的版本；菜品定版時元件必須已定版', async () => {
    const soup = await soupDraft('草案湯');
    const dish = await createRecipe(t, { type: 'dish', name: '引用測試麵' });
    const lines = [
      { line_kind: 'component' as const, component_version_id: soup.versionId, quantity: 1, unit: '份' },
      { line_kind: 'ingredient' as const, ingredient_id: salt, quantity: 1, unit: 'g' },
    ];
    await saveDraft(t, dish.versionId, { serving: [600, 'g'], lines });
    await expectError(lock(dish.versionId), '引用的元件「草案湯」v1 為「草案」，要先定版元件');

    // 被引用的草案不能刪，要說明是誰在用
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId });
    await saveDraft(t, dish.versionId, { serving: [600, 'g'], lines: [{ ...lines[0], component_version_id: v2 }, lines[1]] });
    await expectError(t.rpc(t.users.chef, 'delete_draft', { p_version_id: v2 }), '被其他食譜引用（引用測試麵 v1）');
    await saveDraft(t, dish.versionId, { serving: [600, 'g'], lines });

    await lock(soup.versionId);
    await expect(lock(dish.versionId)).resolves.toMatchObject({ status: 'locked' });

    const sauce = await soupLocked('自我引用醬');
    const sauceV2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: sauce.versionId });
    await expectError(
      saveDraft(t, sauceV2, {
        batch: [100, 'g'],
        serving: [10, 'g'],
        lines: [{ line_kind: 'component', component_version_id: sauce.versionId, quantity: 10, unit: 'g' }],
      }),
      '不能引用自己的食譜',
    );

    const old = await soupLocked('已被取代的湯');
    const newer = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: old.versionId });
    await lock(newer);
    const another = await createRecipe(t, { type: 'dish', name: '引用舊版的麵' });
    await expectError(
      saveDraft(t, another.versionId, {
        serving: [600, 'g'],
        lines: [{ line_kind: 'component', component_version_id: old.versionId, quantity: 1, unit: '份' }],
      }),
      '請引用草案或已定版的元件版本',
    );
  });

  it('被取代的元件版本會出現在首頁的「引用過時元件」清單', async () => {
    const soup = await soupLocked('過時測試湯');
    const dish = await createRecipe(t, { type: 'dish', name: '過時測試麵' });
    await saveDraft(t, dish.versionId, {
      serving: [600, 'g'],
      lines: [{ line_kind: 'component', component_version_id: soup.versionId, quantity: 380, unit: 'ml' }],
    });
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId });
    await lock(v2);

    const dash = await t.rpc<{ outdated_references: Array<{ recipe_name: string; component_locked_version_no: number }> }>(
      t.users.chef,
      'get_dashboard',
    );
    expect(dash.outdated_references).toContainEqual(
      expect.objectContaining({ recipe_name: '過時測試麵', component_locked_version_no: 2 }),
    );
    // 既有的舊引用可以保留並繼續編輯其他欄位
    const current = await t.rpc<{ revision: number; lines: Array<{ id: string }> }>(t.users.chef, 'get_version', { p_id: dish.versionId });
    await expect(
      t.rpc(t.users.chef, 'save_version_draft', {
        p_version_id: dish.versionId,
        p_revision: current.revision,
        p: {
          serving_qty: 650,
          serving_unit: 'g',
          lines: [{ id: current.lines[0].id, line_kind: 'component', component_version_id: soup.versionId, quantity: 400, unit: 'ml' }],
        },
      }),
    ).resolves.toBeTypeOf('number');
  });
});

describe('複製與刪除', () => {
  it('複製版本：內容相同、版本號遞增；刪除的號碼不回收', async () => {
    const soup = await soupLocked('複製測試湯');
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId, p_change_note: '減鹽' });
    const copy = await t.rpc<{
      version_no: number;
      status: string;
      based_on_version_no: number;
      lines: Array<{ quantity: number }>;
      steps: Array<{ instruction: string }>;
    }>(t.users.chef, 'get_version', { p_id: v2 });
    expect(copy).toMatchObject({ version_no: 2, status: 'draft', based_on_version_no: 1 });
    expect(copy.lines.map((l) => l.quantity)).toEqual([1800]);
    expect(copy.steps.map((s) => s.instruction)).toEqual(['汆燙']);

    await t.rpc(t.users.chef, 'delete_draft', { p_version_id: v2 });
    const v3 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId });
    const third = await t.rpc<{ version_no: number }>(t.users.chef, 'get_version', { p_id: v3 });
    expect(third.version_no).toBe(3);
  });

  it('只有草案能刪除；食譜至少保留一個版本', async () => {
    const soup = await soupLocked('刪除測試湯');
    await expectError(t.rpc(t.users.chef, 'delete_draft', { p_version_id: soup.versionId }), '只有草案可以刪除');
    const only = await createRecipe(t, { type: 'dish', name: '唯一版本菜' });
    await expectError(t.rpc(t.users.chef, 'delete_draft', { p_version_id: only.versionId }), '至少要保留一個版本');

    // 舊的試菜資料要保留：有試做紀錄的草案不能刪
    const old = await soupLocked('舊試菜湯');
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: old.versionId });
    const [session] = await t.sql<{ id: string }>(`insert into app.tasting_sessions (tasted_on, title) values ('2026-09-22', '舊場次') returning id`);
    await t.sql(`insert into app.tasting_items (session_id, version_id) values ($1, $2)`, [session.id, v2]);
    await expectError(t.rpc(t.users.chef, 'delete_draft', { p_version_id: v2 }), '有舊的試菜紀錄');
  });
});

describe('照片權限（Storage policy 使用的函式）', () => {
  it('廚房角色看得到與上傳；其他角色不行；紀錄刪掉後才能刪檔案', async () => {
    const soup = await soupDraft('照片權限湯');
    const path = `versions/${soup.versionId}/a.webp`;
    await t.rpc(t.users.chef, 'add_photo', { p: { version_id: soup.versionId, storage_path: path } });
    await expectError(
      t.rpc(t.users.chef, 'add_photo', { p: { version_id: soup.versionId, storage_path: 'versions/other/not-allowed.webp' } }),
      '照片路徑與所屬資料不符',
    );

    await expect(t.rpc(t.users.chef, 'can_view_photo', { p_storage_path: path })).resolves.toBe(true);
    await expect(t.rpc(t.users.manager, 'can_view_photo', { p_storage_path: path })).resolves.toBe(true);
    await expect(t.rpc(t.users.tester, 'can_view_photo', { p_storage_path: path })).resolves.toBe(false);
    await expect(t.rpc(t.users.pending, 'can_view_photo', { p_storage_path: path })).resolves.toBe(false);

    await expect(t.rpc(t.users.manager, 'can_upload_photo')).resolves.toBe(true);
    await expect(t.rpc(t.users.tester, 'can_upload_photo')).resolves.toBe(false);

    await expect(t.rpc(t.users.chef, 'can_delete_photo_file', { p_storage_path: path })).resolves.toBe(false);
    const [photo] = await t.sql<{ id: string }>('select id from app.photos where storage_path = $1', [path]);
    await expect(t.rpc(t.users.chef, 'delete_photo', { p_id: photo.id })).resolves.toMatchObject({ still_referenced: false });
    await expect(t.rpc(t.users.chef, 'can_delete_photo_file', { p_storage_path: path })).resolves.toBe(true);
    await expect(t.rpc(t.users.tester, 'can_delete_photo_file', { p_storage_path: path })).resolves.toBe(false);
  });
});

describe('不可竄改歷程', () => {
  it('狀態歷程與定版成本快照都不能透過資料庫直接刪除', async () => {
    const soup = await soupLocked('歷程保護湯');
    await expectError(
      t.sql(`delete from app.version_status_history where version_id = $1`, [soup.versionId]),
      '狀態歷程只能新增',
    );
    await expectError(
      t.sql(`delete from app.cost_snapshots where version_id = $1`, [soup.versionId]),
      '成本快照只能新增',
    );
  });
});

describe('全系統校正（2026-10-02）', () => {
  it('菜品清單的「最新版本」略過已放棄（停用）的版本', async () => {
    const soup = await soupLocked('放棄新版湯');
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId });
    await lock(v2);
    await transition(t, t.users.founder, v2, 'retired', '方向錯了');
    const list = await t.rpc<Array<{ id: string; latest: { id: string; version_no: number; status: string } }>>(
      t.users.chef,
      'list_recipes',
      { p_type: 'component', p_q: '放棄新版湯' },
    );
    expect(list[0].latest).toMatchObject({ version_no: 2, status: 'retired' });
  });

  it('包裝規格已有報價時不能修改包裝數量或單位（名稱、供應商可以改）', async () => {
    const ing = await createIngredient(t, { name: '規格測試蔥', packQty: 3, packUnit: 'kg', price: 270 });
    const base = { id: ing.specId, ingredient_id: ing.id, spec_name: '3 kg', pack_qty: 3, pack_unit: 'kg' };
    await expectError(
      t.rpc(t.users.chef, 'upsert_packaging_spec', { p: { ...base, pack_qty: 5 } }),
      '已經有報價，不能修改包裝數量或單位',
    );
    await expectError(
      t.rpc(t.users.chef, 'upsert_packaging_spec', { p: { ...base, pack_unit: '台斤' } }),
      '已經有報價，不能修改包裝數量或單位',
    );
    await t.rpc(t.users.chef, 'upsert_packaging_spec', { p: { ...base, spec_name: '一箱 3 kg' } });
    // 報價全部作廢後就可以改
    const [price] = await t.sql<{ id: string }>('select id from app.purchase_prices where packaging_spec_id = $1', [ing.specId]);
    await t.rpc(t.users.founder, 'void_purchase_price', { p_id: price.id, p_reason: '規格打錯' });
    await t.rpc(t.users.chef, 'upsert_packaging_spec', { p: { ...base, pack_qty: 5 } });
  });
});

describe('預設包裝規格', () => {
  it('預設規格不能停用；把別的規格設為預設後就可以', async () => {
    const ing = await createIngredient(t, { name: '預設規格測試鹽', packQty: 1, packUnit: 'kg', price: 30 });
    const base = { id: ing.specId, ingredient_id: ing.id, spec_name: '1 kg', pack_qty: 1, pack_unit: 'kg' };
    await expectError(t.rpc(t.users.chef, 'upsert_packaging_spec', { p: { ...base, is_active: false } }), '預設規格不能停用');
    await t.rpc(t.users.chef, 'upsert_packaging_spec', {
      p: { ingredient_id: ing.id, spec_name: '3 kg', pack_qty: 3, pack_unit: 'kg', is_default: true },
    });
    await t.rpc(t.users.chef, 'upsert_packaging_spec', { p: { ...base, is_active: false } });
  });
});
