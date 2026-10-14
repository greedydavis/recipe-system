import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './harness';
import { expectError } from './fixtures';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

interface Task {
  id: string;
  name: string;
  category: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  is_done: boolean;
  note: string;
}

const list = (user = t.users.founder) => t.rpc<Task[]>(user, 'list_schedule_tasks');
const upsert = (user: string | null, p: Record<string, unknown>) => t.rpc<string>(user, 'upsert_schedule_task', { p });

describe('開店時間表', () => {
  it('創辦人、主廚、店長可以看和改；測試人員、待審核、未登入不行', async () => {
    for (const role of ['founder', 'chef', 'manager'] as const) {
      const id = await upsert(t.users[role], { name: `測試項目 ${role}`, start_date: '2026-09-01', end_date: '2026-09-03' });
      await expect(list(t.users[role])).resolves.toBeDefined();
      await t.rpc(t.users[role], 'delete_schedule_task', { p_id: id });
    }
    const id = await upsert(t.users.founder, { name: '權限測試', start_date: '2026-09-01', end_date: '2026-09-03' });
    for (const role of ['tester', 'pending'] as const) {
      await expectError(list(t.users[role]), '權限不足');
      await expectError(upsert(t.users[role], { name: 'x', start_date: '2026-09-01', end_date: '2026-09-02' }), '權限不足');
      await expectError(t.rpc(t.users[role], 'delete_schedule_task', { p_id: id }), '權限不足');
    }
    await expectError(list(null as unknown as string), '請先登入');
    await t.rpc(t.users.founder, 'delete_schedule_task', { p_id: id });
  });

  it('新增、修改、依開始日排序；拖拉只帶日期時其他欄位不變', async () => {
    const later = await upsert(t.users.founder, {
      name: '  設備進場  ',
      category: '設備',
      start_date: '2026-10-10',
      end_date: '2026-10-12',
      note: '廠商甲',
    });
    const earlier = await upsert(t.users.manager, { name: '水電配管', category: '裝潢', start_date: '2026-09-05', end_date: '2026-09-20' });
    expect((await list()).map((x) => x.name)).toEqual(['水電配管', '設備進場']);

    // 拖拉：只帶 id 和日期
    await upsert(t.users.chef, { id: later, start_date: '2026-09-02', end_date: '2026-09-04' });
    const moved = (await list()).find((x) => x.id === later)!;
    expect(moved).toMatchObject({ name: '設備進場', category: '設備', note: '廠商甲', start_date: '2026-09-02', end_date: '2026-09-04', is_done: false });
    expect((await list()).map((x) => x.name)).toEqual(['設備進場', '水電配管']);

    await upsert(t.users.founder, { id: earlier, name: '水電配管', category: '裝潢', start_date: '2026-09-05', end_date: '2026-09-05', is_done: true, note: '' });
    expect((await list()).find((x) => x.id === earlier)).toMatchObject({ is_done: true, end_date: '2026-09-05' });
  });

  it('時間選填；拖拉只改日期時保留時間；同一天的結束時間不能早於開始時間', async () => {
    const id = await upsert(t.users.founder, {
      name: '冷凍櫃進場',
      start_date: '2026-10-15',
      end_date: '2026-10-15',
      start_time: '09:00',
      end_time: '12:30',
    });
    const find = async () => (await list()).find((x) => x.id === id)!;
    expect(await find()).toMatchObject({ start_time: '09:00', end_time: '12:30' });

    await upsert(t.users.chef, { id, start_date: '2026-10-16', end_date: '2026-10-16' });
    expect(await find()).toMatchObject({ start_date: '2026-10-16', start_time: '09:00', end_time: '12:30' });

    await expectError(
      upsert(t.users.founder, { id, start_date: '2026-10-16', end_date: '2026-10-16', start_time: '14:00', end_time: '10:00' }),
      '同一天的項目，結束時間不能早於開始時間',
    );
    // 跨天就沒有這個限制；清空時間代表整天
    await upsert(t.users.founder, { id, start_date: '2026-10-16', end_date: '2026-10-17', start_time: '14:00', end_time: '10:00' });
    await upsert(t.users.founder, { id, start_date: '2026-10-16', end_date: '2026-10-17', start_time: '', end_time: '' });
    expect(await find()).toMatchObject({ start_time: null, end_time: null });
    await t.rpc(t.users.founder, 'delete_schedule_task', { p_id: id });
  });

  it('擋下不合理的資料', async () => {
    await expectError(upsert(t.users.founder, { name: '', start_date: '2026-09-01', end_date: '2026-09-02' }), '請填寫項目名稱');
    await expectError(upsert(t.users.founder, { name: '日期反了', start_date: '2026-09-05', end_date: '2026-09-01' }), '結束日期不能早於開始日期');
    await expectError(upsert(t.users.founder, { name: '沒日期' }), '請填寫開始與結束日期');
    const [first] = await list();
    await expectError(upsert(t.users.founder, { id: first.id, name: ' ', start_date: '2026-09-01', end_date: '2026-09-02' }), '請填寫項目名稱');
    await expectError(
      upsert(t.users.founder, { id: '00000000-0000-0000-0000-000000000000', start_date: '2026-09-01', end_date: '2026-09-02' }),
      '找不到此項目',
    );
    await expectError(t.rpc(t.users.founder, 'delete_schedule_task', { p_id: '00000000-0000-0000-0000-000000000000' }), '找不到此項目');
  });

  it('新增、修改、刪除都留下操作紀錄；資料表不能直接讀取', async () => {
    const id = await upsert(t.users.founder, { name: '紀錄測試', start_date: '2026-09-01', end_date: '2026-09-02' });
    await upsert(t.users.founder, { id, start_date: '2026-09-03', end_date: '2026-09-04' });
    await t.rpc(t.users.founder, 'delete_schedule_task', { p_id: id });
    const logs = await t.sql<{ action: string; actor_id: string; changed_fields: string[] | null }>(
      `select action, actor_id, changed_fields from app.audit_logs where table_name = 'schedule_tasks' and record_id = $1 order by id`,
      [id],
    );
    expect(logs.map((l) => l.action)).toEqual(['insert', 'update', 'delete']);
    expect(logs.every((l) => l.actor_id === t.users.founder)).toBe(true);
    expect(logs[1].changed_fields?.sort()).toEqual(['end_date', 'start_date']);

    await expect(
      t.db.transaction(async (tx) => {
        await tx.query('set local role authenticated');
        return tx.query('select * from app.schedule_tasks');
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
