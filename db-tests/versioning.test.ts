import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './harness';
import { COMPLETE_SNAPSHOT, createIngredient, createRecipe, expectError, saveDraft, transition } from './fixtures';

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

async function soupInTesting(name: string) {
  const r = await createRecipe(t, { type: 'component', name });
  await saveDraft(t, r.versionId, {
    batch: [10000, 'ml'],
    serving: [400, 'ml'],
    lines: [{ line_kind: 'ingredient', ingredient_id: bone, quantity: 1800, unit: 'g' }],
    steps: [{ instruction: '汆燙', duration_minutes: 8 }],
  });
  await transition(t, t.users.chef, r.versionId, 'testing');
  return r;
}

async function addFeedback(versionId: string) {
  const session = await t.rpc<string>(t.users.chef, 'create_tasting_session', {
    p: { tasted_on: '2026-09-22', title: '第一輪', items: [{ version_id: versionId, assigned_tester_ids: [t.users.tester] }] },
  });
  const detail = await t.rpc<{ items: Array<{ id: string }> }>(t.users.chef, 'get_tasting_session', { p_id: session });
  await t.rpc(t.users.tester, 'submit_feedback', { p_item_id: detail.items[0].id, p: { score_overall: 4 } });
  return detail.items[0].id;
}

async function lock(versionId: string) {
  await transition(t, t.users.chef, versionId, 'pending_approval', '送審');
  await transition(t, t.users.founder, versionId, 'locked', '', COMPLETE_SNAPSHOT);
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

  it('草案可以有「用量待填」的行，但送試菜時會被擋下', async () => {
    const r = await createRecipe(t, { type: 'dish', name: '待填測試' });
    await saveDraft(t, r.versionId, {
      serving: [500, 'g'],
      lines: [{ line_kind: 'ingredient', ingredient_id: salt, quantity: null, unit: 'g' }],
    });
    await expectError(transition(t, t.users.chef, r.versionId, 'testing'), '「鹽」用量待填');
  });

  it('非草案版本的內容，用 RPC 或直接 SQL 都不能修改', async () => {
    const soup = await soupInTesting('凍結測試湯');
    await expectError(
      t.rpc(t.users.chef, 'save_version_draft', { p_version_id: soup.versionId, p_revision: 2, p: {} }),
      '內容已凍結',
    );
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
    const soup = await soupInTesting('狀態防護湯');
    await expectError(t.sql(`update app.recipe_versions set status = 'locked' where id = $1`, [soup.versionId]), '不允許的狀態轉移');
    await expectError(
      t.sql(`insert into app.recipe_versions (recipe_id, version_no, status) values ($1, 99, 'locked')`, [soup.recipeId]),
      '新版本一律從草案開始',
    );
  });
});

describe('狀態轉移', () => {
  it('必填意見：免試菜原因、送審說明、退回原因、停用原因', async () => {
    const d = await createRecipe(t, { type: 'dish', name: '意見測試' });
    await saveDraft(t, d.versionId, { serving: [1, 'g'], lines: [{ line_kind: 'ingredient', ingredient_id: salt, quantity: 1, unit: 'g' }] });
    await expectError(transition(t, t.users.chef, d.versionId, 'pending_approval'), '請填寫免試菜原因');
    const soup = await soupInTesting('意見測試湯');
    await expectError(transition(t, t.users.chef, soup.versionId, 'pending_approval'), '請填寫送審說明');
    await expectError(transition(t, t.users.chef, soup.versionId, 'retired'), '請填寫停用原因');
  });

  it('送核准：預設需要試吃評分；缺單價時擋下', async () => {
    const soup = await soupInTesting('評分要求湯');
    await expectError(transition(t, t.users.chef, soup.versionId, 'pending_approval', '送審'), '尚未有試吃評分');
    await addFeedback(soup.versionId);
    await expect(transition(t, t.users.chef, soup.versionId, 'pending_approval', '送審')).resolves.toMatchObject({
      status: 'pending_approval',
    });

    const d = await createRecipe(t, { type: 'dish', name: '缺價格菜' });
    await saveDraft(t, d.versionId, {
      serving: [1, 'g'],
      lines: [{ line_kind: 'ingredient', ingredient_id: noPrice, quantity: 1, unit: 'g' }],
    });
    await expectError(transition(t, t.users.chef, d.versionId, 'pending_approval', '只改錯字'), '「乾香菇」沒有有效單價');
  });

  it('只有創辦人能核准；主廚不行；定版需要完整的成本快照', async () => {
    const soup = await soupInTesting('核准測試湯');
    await addFeedback(soup.versionId);
    await transition(t, t.users.chef, soup.versionId, 'pending_approval', '送審');
    await expectError(transition(t, t.users.chef, soup.versionId, 'locked', '', COMPLETE_SNAPSHOT), '權限不足');
    await expectError(transition(t, t.users.founder, soup.versionId, 'locked'), '缺少成本快照');
    await expectError(
      transition(t, t.users.founder, soup.versionId, 'locked', '', { ...COMPLETE_SNAPSHOT, is_complete: false }),
      '成本不完整',
    );
    await transition(t, t.users.founder, soup.versionId, 'locked', '湯頭清澈', COMPLETE_SNAPSHOT);
    const v = await t.rpc<{ status: string; approved_by_name: string; snapshots: unknown[]; history: Array<{ to_status: string }> }>(
      t.users.chef,
      'get_version',
      { p_id: soup.versionId },
    );
    expect(v.status).toBe('locked');
    expect(v.approved_by_name).toBe('創辦人');
    expect(v.snapshots).toHaveLength(1);
    expect(v.history[0].to_status).toBe('locked');
  });

  it('新版本定版時，舊定版自動停用並記錄被取代', async () => {
    const soup = await soupInTesting('取代測試湯');
    await addFeedback(soup.versionId);
    await lock(soup.versionId);

    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId, p_change_note: '大骨增量' });
    await transition(t, t.users.chef, v2, 'testing');
    await addFeedback(v2);
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

  it('退回草案：已有試做項目或已被引用時不行', async () => {
    const a = await soupInTesting('退回測試湯A');
    await addFeedback(a.versionId);
    await expectError(transition(t, t.users.chef, a.versionId, 'draft'), '已經有試做項目');

    const b = await soupInTesting('退回測試湯B');
    const dish = await createRecipe(t, { type: 'dish', name: '引用B的菜' });
    await saveDraft(t, dish.versionId, {
      serving: [500, 'g'],
      lines: [{ line_kind: 'component', component_version_id: b.versionId, quantity: 380, unit: 'ml' }],
    });
    await expectError(transition(t, t.users.chef, b.versionId, 'draft'), '已被其他食譜版本引用');

    const c = await soupInTesting('退回測試湯C');
    await expect(transition(t, t.users.chef, c.versionId, 'draft')).resolves.toMatchObject({ status: 'draft' });
  });

  it('停用是終點；已定版只有創辦人能停用', async () => {
    const soup = await soupInTesting('停用測試湯');
    await addFeedback(soup.versionId);
    await lock(soup.versionId);
    await expectError(transition(t, t.users.chef, soup.versionId, 'retired', '不用了'), '權限不足');
    await transition(t, t.users.founder, soup.versionId, 'retired', '不用了');
    await expectError(transition(t, t.users.founder, soup.versionId, 'locked', '', COMPLETE_SNAPSHOT), '不允許的狀態轉移');
  });
});

describe('元件引用', () => {
  it('不能引用草案或自己的食譜；菜品定版時引用的元件必須已定版', async () => {
    const draftSoup = await createRecipe(t, { type: 'component', name: '草案湯' });
    const dish = await createRecipe(t, { type: 'dish', name: '引用測試麵' });
    await expectError(
      saveDraft(t, dish.versionId, {
        serving: [600, 'g'],
        lines: [{ line_kind: 'component', component_version_id: draftSoup.versionId, quantity: 380, unit: 'ml' }],
      }),
      '只能引用試菜中、待核准或已定版的元件版本',
    );

    const sauce = await createRecipe(t, { type: 'component', name: '自我引用醬', kind: 'sauce' });
    await saveDraft(t, sauce.versionId, {
      batch: [100, 'g'],
      serving: [10, 'g'],
      lines: [{ line_kind: 'ingredient', ingredient_id: salt, quantity: 100, unit: 'g' }],
    });
    await transition(t, t.users.chef, sauce.versionId, 'testing');
    const sauceV2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: sauce.versionId });
    await expectError(
      saveDraft(t, sauceV2, {
        batch: [100, 'g'],
        serving: [10, 'g'],
        lines: [{ line_kind: 'component', component_version_id: sauce.versionId, quantity: 10, unit: 'g' }],
      }),
      '不能引用自己的食譜',
    );

    const soup = await soupInTesting('試菜中的湯');
    await saveDraft(t, dish.versionId, {
      serving: [600, 'g'],
      lines: [
        { line_kind: 'component', component_version_id: soup.versionId, quantity: 1, unit: '份' },
        { line_kind: 'ingredient', ingredient_id: salt, quantity: 1, unit: 'g' },
      ],
    });
    await transition(t, t.users.chef, dish.versionId, 'pending_approval', '測試');
    await expectError(
      transition(t, t.users.founder, dish.versionId, 'locked', '', COMPLETE_SNAPSHOT),
      '定版前必須引用已定版的元件版本',
    );
  });

  it('被取代的元件版本會出現在首頁的「引用過時元件」清單', async () => {
    const soup = await soupInTesting('過時測試湯');
    await addFeedback(soup.versionId);
    await lock(soup.versionId);
    const dish = await createRecipe(t, { type: 'dish', name: '過時測試麵' });
    await saveDraft(t, dish.versionId, {
      serving: [600, 'g'],
      lines: [{ line_kind: 'component', component_version_id: soup.versionId, quantity: 380, unit: 'ml' }],
    });
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId });
    await transition(t, t.users.chef, v2, 'testing');
    await addFeedback(v2);
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
  it('複製版本：內容相同、版本號遞增、不複製試菜紀錄；刪除的號碼不回收', async () => {
    const soup = await soupInTesting('複製測試湯');
    await addFeedback(soup.versionId);
    const v2 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId, p_change_note: '減鹽' });
    const copy = await t.rpc<{
      version_no: number;
      status: string;
      based_on_version_no: number;
      lines: Array<{ quantity: number }>;
      steps: Array<{ instruction: string }>;
      tastings: unknown[];
    }>(t.users.chef, 'get_version', { p_id: v2 });
    expect(copy).toMatchObject({ version_no: 2, status: 'draft', based_on_version_no: 1 });
    expect(copy.lines.map((l) => l.quantity)).toEqual([1800]);
    expect(copy.steps.map((s) => s.instruction)).toEqual(['汆燙']);
    expect(copy.tastings).toEqual([]);

    await t.rpc(t.users.chef, 'delete_draft', { p_version_id: v2 });
    const v3 = await t.rpc<string>(t.users.chef, 'copy_version', { p_source_id: soup.versionId });
    const third = await t.rpc<{ version_no: number }>(t.users.chef, 'get_version', { p_id: v3 });
    expect(third.version_no).toBe(3);
  });

  it('只有草案能刪除；食譜至少保留一個版本', async () => {
    const soup = await soupInTesting('刪除測試湯');
    await expectError(t.rpc(t.users.chef, 'delete_draft', { p_version_id: soup.versionId }), '只有草案可以刪除');
    const only = await createRecipe(t, { type: 'dish', name: '唯一版本菜' });
    await expectError(t.rpc(t.users.chef, 'delete_draft', { p_version_id: only.versionId }), '至少要保留一個版本');
  });
});

describe('試菜評分', () => {
  it('測試人員只看得到指派給自己的項目，且只看得到盲測代號', async () => {
    const soup = await soupInTesting('盲測湯');
    const session = await t.rpc<string>(t.users.manager, 'create_tasting_session', {
      p: {
        tasted_on: '2026-09-22',
        title: '盲測',
        items: [{ version_id: soup.versionId, blind_label: 'A', assigned_tester_ids: [t.users.tester] }],
      },
    });
    const mine = await t.rpc<Array<{ display_name: string; item_id: string }>>(t.users.tester, 'get_my_tasting_tasks');
    const task = mine.find((x) => x.display_name === 'A');
    expect(task).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain('盲測湯');
    const other = await t.rpc<unknown[]>(t.users.tester2, 'get_my_tasting_tasks');
    expect(JSON.stringify(other)).not.toContain(task!.item_id);
    await expectError(t.rpc(t.users.tester2, 'submit_feedback', { p_item_id: task!.item_id, p: { score_overall: 3 } }), '權限不足');
    await expectError(t.rpc(t.users.tester, 'get_tasting_session', { p_id: session }), '權限不足');
  });

  it('評分：重複送出會更新自己的那一筆；測試人員不能代填；分數範圍檢查', async () => {
    const soup = await soupInTesting('評分測試湯');
    const itemId = await addFeedback(soup.versionId);
    await t.rpc(t.users.tester, 'submit_feedback', { p_item_id: itemId, p: { score_overall: 2, saltiness: 1, issues: '偏鹹' } });
    const [{ n }] = await t.sql<{ n: number }>(`select count(*)::int as n from app.tasting_feedback where tasting_item_id = $1`, [itemId]);
    expect(n).toBe(1);
    await expectError(
      t.rpc(t.users.tester, 'submit_feedback', { p_item_id: itemId, p: { score_overall: 3, taster_name: '朋友' } }),
      '只能填寫自己的評分',
    );
    await expectError(t.rpc(t.users.chef, 'submit_feedback', { p_item_id: itemId, p: { score_overall: 6 } }), '1 到 5');
    await expectError(t.rpc(t.users.chef, 'submit_feedback', { p_item_id: itemId, p: { score_overall: 3, saltiness: 3 } }), '-2 到 +2');
    await t.rpc(t.users.chef, 'submit_feedback', { p_item_id: itemId, p: { score_overall: 5, taster_name: '外部朋友' } });
    const s = await t.rpc<{ items: Array<{ stats: { count: number; avg_overall: number } }> }>(t.users.chef, 'get_tasting_session', {
      p_id: (await t.sql<{ session_id: string }>(`select session_id from app.tasting_items where id = $1`, [itemId]))[0].session_id,
    });
    expect(s.items[0].stats).toMatchObject({ count: 2, avg_overall: 3.5 });
  });

  it('版本定版後，定版前的評分不能再修改', async () => {
    const soup = await soupInTesting('鎖評分湯');
    const itemId = await addFeedback(soup.versionId);
    await lock(soup.versionId);
    await expectError(t.rpc(t.users.tester, 'submit_feedback', { p_item_id: itemId, p: { score_overall: 1 } }), '評分不能再修改');
  });

  it('草案不能試做', async () => {
    const d = await createRecipe(t, { type: 'dish', name: '草案試做菜' });
    await expectError(
      t.rpc(t.users.chef, 'create_tasting_session', { p: { tasted_on: '2026-09-22', items: [{ version_id: d.versionId }] } }),
      '只有試菜中、待核准或已定版的版本可以試做',
    );
  });
});

describe('照片權限（Storage policy 使用的函式）', () => {
  it('測試人員只能看指派給自己的試做照；上傳與刪除檔案只限廚房角色', async () => {
    const soup = await soupInTesting('照片權限湯');
    const itemId = await addFeedback(soup.versionId);
    const path = `tastings/${itemId}/a.webp`;
    await t.rpc(t.users.manager, 'add_photo', { p: { tasting_item_id: itemId, storage_path: path } });

    await expect(t.rpc(t.users.tester, 'can_view_photo', { p_storage_path: path })).resolves.toBe(true);
    await expect(t.rpc(t.users.tester2, 'can_view_photo', { p_storage_path: path })).resolves.toBe(false);
    await expect(t.rpc(t.users.pending, 'can_view_photo', { p_storage_path: path })).resolves.toBe(false);
    await expect(t.rpc(t.users.chef, 'can_view_photo', { p_storage_path: path })).resolves.toBe(true);

    await expect(t.rpc(t.users.manager, 'can_upload_photo')).resolves.toBe(true);
    await expect(t.rpc(t.users.tester, 'can_upload_photo')).resolves.toBe(false);

    await expect(t.rpc(t.users.chef, 'can_delete_photo_file', { p_storage_path: path })).resolves.toBe(false);
    const [photo] = await t.sql<{ id: string }>('select id from app.photos where storage_path = $1', [path]);
    await expectError(t.rpc(t.users.chef, 'delete_photo', { p_id: photo.id }), '權限不足');
    await expect(t.rpc(t.users.manager, 'delete_photo', { p_id: photo.id })).resolves.toMatchObject({ still_referenced: false });
    await expect(t.rpc(t.users.chef, 'can_delete_photo_file', { p_storage_path: path })).resolves.toBe(true);
    await expect(t.rpc(t.users.tester, 'can_delete_photo_file', { p_storage_path: path })).resolves.toBe(false);
  });
});

describe('試菜場次的項目增刪', () => {
  it('建立後可以再加入項目；有評分的項目不能移除；測試人員不能加也不能移', async () => {
    const a = await soupInTesting('加項目湯A');
    const b = await soupInTesting('加項目湯B');
    const session = await t.rpc<string>(t.users.manager, 'create_tasting_session', {
      p: { tasted_on: '2026-09-22', title: '第一輪', items: [{ version_id: a.versionId, blind_label: 'A', assigned_tester_ids: [t.users.tester] }] },
    });

    await expectError(
      t.rpc(t.users.tester, 'add_tasting_item', { p_session_id: session, p: { version_id: b.versionId } }),
      '權限不足',
    );
    const itemB = await t.rpc<string>(t.users.manager, 'add_tasting_item', {
      p_session_id: session,
      p: { version_id: b.versionId, blind_label: 'B', assigned_tester_ids: [t.users.tester, t.users.tester2] },
    });
    await expectError(
      t.rpc(t.users.chef, 'add_tasting_item', { p_session_id: session, p: { version_id: b.versionId } }),
      '這個場次已經有此版本',
    );

    const detail = await t.rpc<{ items: Array<{ id: string; blind_label: string; assigned_testers: unknown[] }> }>(
      t.users.chef,
      'get_tasting_session',
      { p_id: session },
    );
    expect(detail.items).toHaveLength(2);
    expect(detail.items[1]).toMatchObject({ id: itemB, blind_label: 'B' });
    expect(detail.items[1].assigned_testers).toHaveLength(2);

    // 新加入的項目，被指派的人馬上看得到
    const tasks = await t.rpc<Array<{ item_id: string }>>(t.users.tester2, 'get_my_tasting_tasks');
    expect(tasks.map((x) => x.item_id)).toContain(itemB);

    // 修改指派
    await t.rpc(t.users.manager, 'update_tasting_item', {
      p_id: itemB,
      p: { blind_label: 'C', deviation_note: '火力偏小', assigned_tester_ids: [t.users.tester] },
    });
    const after = await t.rpc<{ items: Array<{ id: string; blind_label: string; deviation_note: string; assigned_testers: unknown[] }> }>(
      t.users.chef,
      'get_tasting_session',
      { p_id: session },
    );
    const updated = after.items.find((x) => x.id === itemB)!;
    expect(updated).toMatchObject({ blind_label: 'C', deviation_note: '火力偏小' });
    expect(updated.assigned_testers).toHaveLength(1);

    // 移除：有評分就不行
    await expectError(t.rpc(t.users.tester, 'delete_tasting_item', { p_id: itemB }), '權限不足');
    await t.rpc(t.users.tester, 'submit_feedback', { p_item_id: itemB, p: { score_overall: 3 } });
    await expectError(t.rpc(t.users.chef, 'delete_tasting_item', { p_id: itemB }), '已經有評分的試做項目不能刪除');

    const itemA = after.items.find((x) => x.id !== itemB)!;
    await t.rpc(t.users.chef, 'delete_tasting_item', { p_id: itemA.id });
    const final = await t.rpc<{ items: unknown[] }>(t.users.chef, 'get_tasting_session', { p_id: session });
    expect(final.items).toHaveLength(1);
  });
});

describe('產量試做後再填', () => {
  async function soupWithoutYield(name: string) {
    const r = await createRecipe(t, { type: 'component', name });
    await t.rpc(t.users.chef, 'save_version_draft', {
      p_version_id: r.versionId,
      p_revision: 1,
      p: {
        batch_output_unit: 'ml',
        serving_unit: 'ml',
        lines: [{ id: crypto.randomUUID(), line_kind: 'ingredient', ingredient_id: bone, quantity: 1800, unit: 'g' }],
      },
    });
    return r;
  }

  it('沒填產量也可以送試菜，但送核准會被擋下', async () => {
    const soup = await soupWithoutYield('未填產量湯');
    await expect(transition(t, t.users.chef, soup.versionId, 'testing')).resolves.toMatchObject({ status: 'testing' });
    await addFeedback(soup.versionId);
    await expectError(transition(t, t.users.chef, soup.versionId, 'pending_approval', '送審'), '請填寫批次產量');
  });

  it('試菜中可以記錄實際產量，記錄後才能送核准', async () => {
    const soup = await soupWithoutYield('記錄產量湯');
    await transition(t, t.users.chef, soup.versionId, 'testing');
    await addFeedback(soup.versionId);

    await expectError(t.rpc(t.users.manager, 'record_yield', { p_version_id: soup.versionId, p: {} }), '權限不足');
    await expectError(t.rpc(t.users.tester, 'record_yield', { p_version_id: soup.versionId, p: {} }), '權限不足');

    await t.rpc(t.users.chef, 'record_yield', {
      p_version_id: soup.versionId,
      p: { batch_output_qty: 9800, batch_output_unit: 'ml', serving_qty: 380, serving_unit: 'ml' },
    });
    const v = await t.rpc<{ batch_output_qty: number; serving_qty: number }>(t.users.chef, 'get_version', { p_id: soup.versionId });
    expect(v).toMatchObject({ batch_output_qty: 9800, serving_qty: 380 });

    const logs = await t.rpc<{ items: Array<{ context: string; changed_fields: string[] }> }>(t.users.founder, 'list_audit_logs', {
      p: { table_name: 'recipe_versions', record_id: soup.versionId },
    });
    expect(logs.items[0]).toMatchObject({ context: 'record_yield' });
    expect(logs.items[0].changed_fields).toContain('batch_output_qty');

    await expect(transition(t, t.users.chef, soup.versionId, 'pending_approval', '送審')).resolves.toMatchObject({
      status: 'pending_approval',
    });
    // 待核准之後連產量都鎖住
    await expectError(t.rpc(t.users.chef, 'record_yield', { p_version_id: soup.versionId, p: { batch_output_qty: 1 } }), '只有「試菜中」');
    await expectError(t.sql(`update app.recipe_versions set batch_output_qty = 1 where id = $1`, [soup.versionId]), '內容已凍結');
  });

  it('定版後產量也不能再改', async () => {
    const soup = await soupInTesting('定版產量湯');
    await addFeedback(soup.versionId);
    await lock(soup.versionId);
    await expectError(t.sql(`update app.recipe_versions set batch_output_qty = 1 where id = $1`, [soup.versionId]), '內容已凍結');
  });
});
