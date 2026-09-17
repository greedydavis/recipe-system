-- 只在 Supabase 執行（PGlite 沒有 storage schema）：照片 bucket 與存取規則
-- 在所有 migrations 之後執行一次。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "photos_select" on storage.objects;
drop policy if exists "photos_insert" on storage.objects;
drop policy if exists "photos_delete" on storage.objects;

-- 讀取：創辦人、主廚、店長可以看所有有紀錄的照片；測試人員只能看指派給自己的試做照
create policy "photos_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.can_view_photo(name));

-- 上傳：創辦人、主廚、店長
create policy "photos_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.can_upload_photo());

-- 刪除檔案：必須先刪掉照片紀錄（delete_photo RPC），而且沒有其他版本共用
create policy "photos_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and public.can_delete_photo_file(name));
