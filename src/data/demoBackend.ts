import { PGlite } from '@electric-sql/pglite';
import { type Backend, type DemoUser, RpcError } from './backend';
import { seedDemoData } from './demoSeed';

const DATA_DIR = 'idb://recipe-system-demo';
const IDB_NAME = '/pglite/recipe-system-demo';
const LOCK_NAME = 'recipe-system-demo-db';
const SESSION_KEY = 'recipe-system-demo-user';

const shim = import.meta.glob('../../supabase/local/auth_shim.sql', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;
const migrations = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const LOCAL_SQL = `
create schema if not exists local;
create table if not exists local.meta (key text primary key, value text not null);
create table if not exists local.blobs (path text primary key, mime text not null, data bytea not null);
`;

function schemaFingerprint(): string {
  const text = Object.keys(migrations)
    .sort()
    .map((k) => migrations[k])
    .join('\n');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${Object.keys(migrations).length}-${h.toString(16)}`;
}

function readSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSession(id: string | null) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // 私密瀏覽等情況下無法保存登入狀態，仍可繼續使用
  }
}

function cleanMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^error:\s*/i, '');
}

function deleteIndexedDb(): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** 同一個瀏覽器只允許一個分頁使用示範資料庫；兩個分頁同時寫入 IndexedDB 會把資料弄壞 */
function acquireTabLock(timeoutMs = 4000): Promise<boolean> {
  if (!('locks' in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    // 重新整理時舊頁面可能還沒釋放，等一下再判斷
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    navigator.locks
      .request(LOCK_NAME, { signal: controller.signal }, () => {
        clearTimeout(timer);
        resolve(true);
        // 持有到分頁關閉
        return new Promise<void>(() => {});
      })
      .catch(() => resolve(false));
  });
}

/**
 * 開啟示範資料庫。只有在「migrations 與示範資料都完整建立」後才寫入 ready 標記；
 * 沒有標記（上次建立到一半被中斷）或 migrations 改變時，整個資料庫刪掉重建。
 */
async function openDatabase(seed: (db: PGlite) => Promise<void>): Promise<PGlite> {
  if (!(await acquireTabLock())) {
    throw new Error('示範模式一次只能在一個分頁使用。請關閉其他開著本系統的分頁，再重新整理這一頁。');
  }
  const fingerprint = schemaFingerprint();
  let db = new PGlite(DATA_DIR);
  await db.waitReady;
  await db.exec(LOCAL_SQL);
  const ready = await db.query<{ value: string }>(`select value from local.meta where key = 'ready'`);
  if (ready.rows[0]?.value === fingerprint) return db;

  const dirty = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_namespace where nspname in ('app', 'auth')`,
  );
  if (dirty.rows[0].n > 0) {
    await db.close();
    await deleteIndexedDb();
    db = new PGlite(DATA_DIR);
    await db.waitReady;
    await db.exec(LOCAL_SQL);
  }

  await db.exec(Object.values(shim)[0]);
  for (const key of Object.keys(migrations).sort()) {
    await db.exec(migrations[key]);
  }
  await seed(db);
  await db.query(`insert into local.meta (key, value) values ('ready', $1) on conflict (key) do update set value = excluded.value`, [
    fingerprint,
  ]);
  return db;
}

export async function createDemoBackend(): Promise<Backend> {
  let db!: PGlite;
  const seed = async (target: PGlite) => {
    db = target;
    await seedDemoData({
      createUser: async (email, displayName) => {
        const res = await target.query<{ id: string }>(
          `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
          [email, JSON.stringify({ display_name: displayName })],
        );
        return res.rows[0].id;
      },
      setRole: async (id, role) => {
        await target.query(`update app.profiles set role = $1 where id = $2`, [role, id]);
      },
      rpcAs,
    });
  };
  db = await openDatabase(seed);
  const listeners = new Set<() => void>();
  let userId = readSession();
  const objectUrls = new Map<string, string>();

  const notify = () => listeners.forEach((cb) => cb());

  async function rpcAs<T>(uid: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!/^[a-z_]+$/.test(fn)) throw new RpcError('無效的操作');
    const names = Object.keys(args).filter((k) => args[k] !== undefined);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`;
    const values = names.map((n) => {
      const v = args[n];
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
      return JSON.stringify(v);
    });
    try {
      return await db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : '']);
        await tx.query('set local role authenticated');
        const res = await tx.query<{ result: T }>(sql, values);
        return res.rows[0]?.result as T;
      });
    } catch (error) {
      throw new RpcError(cleanMessage(error));
    }
  }

  if (userId) {
    const exists = await db.query(`select 1 from app.profiles where id = $1`, [userId]);
    if (exists.rows.length === 0) {
      userId = null;
      writeSession(null);
    }
  }

  return {
    mode: 'demo',

    async getSession() {
      if (!userId) return null;
      const res = await db.query<{ email: string | null }>(`select email from auth.users where id = $1`, [userId]);
      return res.rows[0] ? { id: userId, email: res.rows[0].email } : null;
    },

    onAuthChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    async signIn(email) {
      const res = await db.query<{ id: string }>(`select id from auth.users where lower(email) = lower($1)`, [email.trim()]);
      if (!res.rows[0]) throw new RpcError('示範模式找不到這個帳號，請直接點選下方的示範帳號');
      userId = res.rows[0].id;
      writeSession(userId);
      notify();
    },

    async signUp(email, _password, displayName) {
      try {
        const res = await db.query<{ id: string }>(
          `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
          [email.trim(), JSON.stringify({ display_name: displayName })],
        );
        userId = res.rows[0].id;
        writeSession(userId);
        notify();
      } catch {
        throw new RpcError('這個 Email 已經註冊過');
      }
    },

    async signOut() {
      userId = null;
      writeSession(null);
      notify();
    },

    rpc<T>(fn: string, args?: Record<string, unknown>) {
      return rpcAs<T>(userId, fn, args);
    },

    async uploadPhoto(path, file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await db.query(`insert into local.blobs (path, mime, data) values ($1, $2, $3) on conflict (path) do nothing`, [
        path,
        file.type || 'image/webp',
        bytes,
      ]);
    },

    async photoUrl(path) {
      const cached = objectUrls.get(path);
      if (cached) return cached;
      const res = await db.query<{ mime: string; data: Uint8Array }>(`select mime, data from local.blobs where path = $1`, [path]);
      const row = res.rows[0];
      if (!row) throw new RpcError('找不到照片檔案');
      const url = URL.createObjectURL(new Blob([row.data as BlobPart], { type: row.mime }));
      objectUrls.set(path, url);
      return url;
    },

    async removePhotoFile(path) {
      await db.query(`delete from local.blobs where path = $1`, [path]);
      const cached = objectUrls.get(path);
      if (cached) URL.revokeObjectURL(cached);
      objectUrls.delete(path);
    },

    async listDemoUsers() {
      const res = await db.query<DemoUser>(
        `select p.id, p.display_name, p.role, u.email
         from app.profiles p join auth.users u on u.id = p.id
         where p.is_active
         order by array_position(array['founder','chef','manager','tester','pending'], p.role), u.created_at`,
      );
      return res.rows;
    },

    async signInAs(id) {
      userId = id;
      writeSession(id);
      notify();
    },

    async resetDemo() {
      writeSession(null);
      await db.close();
      await deleteIndexedDb();
      location.reload();
    },
  };
}
