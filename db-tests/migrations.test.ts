import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles } from './harness';

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
});
