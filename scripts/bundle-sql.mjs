// 把所有 migrations 與 storage.sql 合併成一個檔案，方便貼到 Supabase SQL Editor 執行。
// 用法：npm run db:bundle → 產生 supabase/setup-all.sql（不進 git）
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const parts = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => `-- ════════ ${f} ════════\n${readFileSync(join(migrationsDir, f), 'utf8')}`);
parts.push(`-- ════════ storage.sql ════════\n${readFileSync(join(root, 'supabase', 'storage.sql'), 'utf8')}`);

// SQL Editor 會把整份內容當成一個交易執行：任何一步失敗都會全部復原
const guard = `do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'app') then
    raise exception '已經安裝過試菜與標準食譜系統（app schema 已存在），不要重複執行這份檔案';
  end if;
end $$;`;

const finish = `-- 讓 Data API 立刻看到新的 RPC
notify pgrst, 'reload schema';

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as rpc_count,
  (select count(*) from pg_tables where schemaname = 'app') as table_count,
  (select count(*) from storage.buckets where id = 'photos') as photo_bucket,
  '安裝完成' as result;`;

const out = join(root, 'supabase', 'setup-all.sql');
writeFileSync(
  out,
  `-- 試菜與標準食譜系統：Supabase 一次性安裝（自動產生，請勿手動修改）\n\n${guard}\n\n${parts.join('\n\n')}\n\n${finish}\n`,
);
console.log(`已產生 ${out}`);
