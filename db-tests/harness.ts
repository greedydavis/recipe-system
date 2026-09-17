import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = join(import.meta.dirname, '..');

export function readSql(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

export function migrationFiles(): string[] {
  const dir = join(root, 'supabase', 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join('supabase', 'migrations', f));
}

export type Role = 'founder' | 'chef' | 'manager' | 'tester' | 'pending';

export interface TestDb {
  db: PGlite;
  users: Record<Role | 'tester2' | 'chef2', string>;
  /** 以指定使用者身分呼叫 RPC（和 Supabase 一樣：authenticated 角色 + JWT sub） */
  rpc<T = unknown>(userId: string | null, fn: string, args?: Record<string, unknown>): Promise<T>;
  /** 以超級使用者執行（測試準備用） */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
}

export async function createTestDb(options: { withUsers?: boolean } = {}): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(readSql('supabase/local/auth_shim.sql'));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readSql(file));
    } catch (error) {
      throw new Error(`執行 ${file} 失敗：${(error as Error).message}`);
    }
  }

  const users = {} as TestDb['users'];
  const withUsers = options.withUsers ?? true;
  // 第一個帳號會自動成為創辦人
  const order: Array<[keyof TestDb['users'], string]> = [
    ['founder', '創辦人'],
    ['chef', '主廚'],
    ['chef2', '副主廚'],
    ['manager', '店長'],
    ['tester', '試吃員甲'],
    ['tester2', '試吃員乙'],
    ['pending', '新帳號'],
  ];
  for (const [key, name] of withUsers ? order : []) {
    const res = await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
      [`${key}@example.test`, JSON.stringify({ display_name: name })],
    );
    users[key] = res.rows[0].id;
  }
  for (const [key] of withUsers ? order : []) {
    const role = key === 'chef2' ? 'chef' : key === 'tester2' ? 'tester' : key;
    await db.query(`update app.profiles set role = $1 where id = $2`, [role, users[key]]);
  }

  const rpc: TestDb['rpc'] = async (userId, fn, args = {}) => {
    const names = Object.keys(args);
    const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
    const values = names.map((n) => {
      const v = args[n];
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
        userId ? JSON.stringify({ sub: userId, role: 'authenticated' }) : '',
      ]);
      await tx.query('set local role authenticated');
      const res = await tx.query<{ result: unknown }>(`select public.${fn}(${placeholders}) as result`, values);
      return res.rows[0]?.result as never;
    });
  };

  const sql: TestDb['sql'] = async (query, params) => {
    const res = await db.query(query, params);
    return res.rows as never;
  };

  return { db, users, rpc, sql };
}
