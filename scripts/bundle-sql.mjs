// 把 migrations 合併成一個檔案，方便貼到 Supabase SQL Editor 執行。
// 用法：
//   npm run db:bundle                         → supabase/setup-all.sql（全新安裝：全部 migrations＋storage.sql）
//   npm run db:bundle -- --from 20261002000012 → supabase/upgrade.sql（已上線的專案：只包含這一版以後的 migrations）
// 兩個檔案都不進 git。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const fromIndex = process.argv.indexOf('--from');
const from = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;
if (fromIndex >= 0 && !/^\d{14}$/.test(from ?? '')) {
  console.error('--from 後面要接 14 位數的 migration 編號，例如 --from 20261002000012');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => !from || f.slice(0, 14) >= from);
if (files.length === 0) {
  console.error(`沒有 ${from} 以後的 migration`);
  process.exit(1);
}
const parts = files.map((f) => `-- ════════ ${f} ════════\n${readFileSync(join(migrationsDir, f), 'utf8')}`);

// 讓 Data API 立刻看到新的 RPC；最後一列顯示資料庫版本，應該等於最後一個 migration 的編號
const reload = `notify pgrst, 'reload schema';`;
const latest = files.at(-1).slice(0, 14);

if (from) {
  const out = join(root, 'supabase', 'upgrade.sql');
  writeFileSync(
    out,
    `-- 試菜與標準食譜系統：升級 ${from} → ${latest}（自動產生，請勿手動修改）
-- 用法：Supabase → SQL Editor → 全選貼上 → Run。整份是一個交易，中途出錯會全部復原。

${parts.join('\n\n')}

${reload}

select (select max(version) from app.schema_migrations) as schema_version, '升級完成' as result;
`,
  );
  console.log(`已產生 ${out}（${files.length} 個 migration，升級到 ${latest}）`);
} else {
  parts.push(`-- ════════ storage.sql ════════\n${readFileSync(join(root, 'supabase', 'storage.sql'), 'utf8')}`);

  // SQL Editor 會把整份內容當成一個交易執行：任何一步失敗都會全部復原
  const guard = `do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'app') then
    raise exception '已經安裝過試菜與標準食譜系統（app schema 已存在），不要重複執行這份檔案；升級請用 npm run db:bundle -- --from <版本>';
  end if;
end $$;`;

  const out = join(root, 'supabase', 'setup-all.sql');
  writeFileSync(
    out,
    `-- 試菜與標準食譜系統：Supabase 一次性安裝（自動產生，請勿手動修改）

${guard}

${parts.join('\n\n')}

${reload}

select
  (select max(version) from app.schema_migrations) as schema_version,
  (select count(*) from storage.buckets where id = 'photos') as photo_bucket,
  '安裝完成' as result;
`,
  );
  console.log(`已產生 ${out}（資料庫版本 ${latest}）`);
}
