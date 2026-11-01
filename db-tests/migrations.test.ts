import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, readSql } from './harness';

const root = join(import.meta.dirname, '..');
/** 從這一版開始，每個 migration 都要用 app.finish_migration() 收尾 */
const FINISH_REQUIRED_FROM = '20261002000012';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

describe('migration 慣例', () => {
  it('每個新 migration 都以 app.finish_migration(自己的版本號) 結尾（重跑權限設定並記錄版本）', () => {
    for (const file of migrationFiles()) {
      const version = basename(file).slice(0, 14);
      if (version < FINISH_REQUIRED_FROM) continue;
      const sql = readFileSync(join(root, file), 'utf8').trimEnd();
      expect(sql.endsWith(`select app.finish_migration('${version}');`), file).toBe(true);
    }
  });

  it('anon 不能執行 public schema 的任何函式（Supabase 預設會開放新函式，測試環境已模擬）', async () => {
    const rows = await t.sql<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('資料庫記錄的版本等於最新的 migration；未登入時不回傳', async () => {
    const latest = basename(migrationFiles().at(-1)!).slice(0, 14);
    expect(await t.rpc<string>(t.users.tester, 'schema_version')).toBe(latest);
    expect(await t.rpc<string | null>(null, 'schema_version')).toBeNull();
    const [{ n }] = await t.sql<{ n: number }>('select count(*)::int as n from app.schema_migrations');
    expect(n).toBe(migrationFiles().length);
  });

  it('流程簡化（0019）：試菜中、待核准回到草案，試菜資料保留，測試人員改回待審核', async () => {
    const db = new PGlite();
    await db.exec(readSql('supabase/local/auth_shim.sql'));
    const files = migrationFiles();
    const target = files.findIndex((f) => basename(f).startsWith('20261101000019'));
    for (const file of files.slice(0, target)) await db.exec(readSql(file));

    const uid = async (email: string) =>
      (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, '{}') returning id`, [email])).rows[0].id;
    await uid('founder@example.test');
    const tester = await uid('tester@example.test');
    await db.query(`update app.profiles set role = 'tester' where id = $1`, [tester]);

    const version = async (name: string, status: string[]) => {
      const r = await db.query<{ id: string }>(
        `insert into app.recipes (code, type, name, next_version_no) values ($1, 'dish', $1, 2) returning id`,
        [name],
      );
      const v = await db.query<{ id: string }>(`insert into app.recipe_versions (recipe_id, version_no) values ($1, 1) returning id`, [r.rows[0].id]);
      for (const st of status) await db.query(`update app.recipe_versions set status = $1 where id = $2`, [st, v.rows[0].id]);
      return v.rows[0].id;
    };
    const testing = await version('試菜中菜', ['testing']);
    const pending = await version('待核准菜', ['testing', 'pending_approval']);
    const locked = await version('已定版菜', ['testing', 'pending_approval', 'locked']);
    const session = await db.query<{ id: string }>(`insert into app.tasting_sessions (tasted_on, title) values ('2026-09-22', '舊場次') returning id`);
    await db.query(`insert into app.tasting_items (session_id, version_id) values ($1, $2)`, [session.rows[0].id, testing]);

    await db.exec(readSql(files[target]));

    const status = async (id: string) =>
      (await db.query<{ status: string }>('select status from app.recipe_versions where id = $1', [id])).rows[0].status;
    expect(await status(testing)).toBe('draft');
    expect(await status(pending)).toBe('draft');
    expect(await status(locked)).toBe('locked');
    const history = await db.query<{ from_status: string; to_status: string }>(
      'select from_status, to_status from app.version_status_history where version_id = $1',
      [pending],
    );
    expect(history.rows).toEqual([{ from_status: 'pending_approval', to_status: 'draft' }]);
    expect((await db.query('select 1 from app.tasting_items')).rows).toHaveLength(1);
    expect((await db.query<{ role: string }>('select role from app.profiles where id = $1', [tester])).rows[0].role).toBe('pending');
    await db.close();
  });
});
