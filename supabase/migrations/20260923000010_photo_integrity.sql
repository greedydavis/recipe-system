-- 照片路徑必須和其資料紀錄的目標一致，避免任意檔案被掛入食譜。

create or replace function public.add_photo(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_version uuid := nullif(p ->> 'version_id', '')::uuid;
  v_step uuid := nullif(p ->> 'step_id', '')::uuid;
  v_item uuid := nullif(p ->> 'tasting_item_id', '')::uuid;
  v_path text := btrim(coalesce(p ->> 'storage_path', ''));
  expected_prefix text;
  v_id uuid;
begin
  if v_item is not null then
    perform app.require_role('founder', 'chef', 'manager');
    if not exists (select 1 from app.tasting_items where id = v_item) then raise exception '找不到此試做項目'; end if;
    expected_prefix := 'tastings/' || v_item || '/';
  elsif v_step is not null then
    perform app.require_role('founder', 'chef');
    if not exists (select 1 from app.recipe_steps where id = v_step) then raise exception '找不到此步驟'; end if;
    expected_prefix := 'steps/' || v_step || '/';
  else
    perform app.require_role('founder', 'chef');
    if not exists (select 1 from app.recipe_versions where id = v_version) then raise exception '找不到此版本'; end if;
    expected_prefix := 'versions/' || v_version || '/';
  end if;
  perform app.set_context('add_photo');
  if num_nonnulls(v_version, v_step, v_item) <> 1 then raise exception '照片必須屬於版本、步驟或試做項目其中之一'; end if;
  if v_path = '' or v_path not like expected_prefix || '%' or position('..' in v_path) > 0 then
    raise exception '照片路徑與所屬資料不符';
  end if;
  insert into app.photos (storage_path, version_id, step_id, tasting_item_id, caption, sort_order)
  values (
    v_path, v_version, v_step, v_item, coalesce(p ->> 'caption', ''),
    coalesce((select max(sort_order) + 1 from app.photos
      where version_id is not distinct from v_version and step_id is not distinct from v_step and tasting_item_id is not distinct from v_item), 0)
  ) returning id into v_id;
  return v_id;
end
$$;

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;
