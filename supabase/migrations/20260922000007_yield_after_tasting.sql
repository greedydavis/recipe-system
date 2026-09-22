-- 批次產量與每份量改成「試做後再填」
-- 產量是實際做完秤出來的結果，不是事前的計畫值，所以送試菜時不再要求；
-- 送核准與定版仍然要填，因為那時候要算每份成本與出成率。
-- 「試菜中」的版本也因此開放記錄產量（只有產量相關的 4 個欄位＋密度），其他內容照樣凍結。

create or replace function app.version_blockers(p_version_id uuid, p_for text) returns text[]
language plpgsql stable as $$
declare
  v app.recipe_versions;
  msgs text[] := '{}';
  rec record;
begin
  select * into v from app.recipe_versions where id = p_version_id;
  if not exists (select 1 from app.recipe_lines where version_id = v.id) then
    msgs := msgs || '至少要有 1 行用料'::text;
  end if;

  -- 產量與每份量：試做後才知道，送核准前才要求
  if p_for in ('approval', 'lock') then
    if v.serving_qty is null then msgs := msgs || '請填寫每份量'::text; end if;
    if v.batch_output_qty is null then msgs := msgs || '請填寫批次產量'::text; end if;
  end if;

  for rec in
    select coalesce(i.name, cr.name) as name
    from app.recipe_lines l
    left join app.ingredients i on i.id = l.ingredient_id
    left join app.recipe_versions cv on cv.id = l.component_version_id
    left join app.recipes cr on cr.id = cv.recipe_id
    where l.version_id = v.id and l.quantity is null
    order by l.sort_order
  loop
    msgs := msgs || format('「%s」用量待填', rec.name);
  end loop;

  for rec in
    select cr.name, cv.version_no, cv.status
    from app.recipe_lines l
    join app.recipe_versions cv on cv.id = l.component_version_id
    join app.recipes cr on cr.id = cv.recipe_id
    where l.version_id = v.id
      and (cv.status in ('draft', 'retired') or (p_for = 'lock' and cv.status <> 'locked'))
  loop
    msgs := msgs || format('引用的元件「%s」v%s 為「%s」%s', rec.name, rec.version_no, app.status_label(rec.status),
      case when p_for = 'lock' then '，定版前必須引用已定版的元件版本' else '' end);
  end loop;

  if p_for in ('approval', 'lock') then
    for rec in
      select distinct i.name
      from app.recipe_lines l join app.ingredients i on i.id = l.ingredient_id
      where l.version_id = v.id
        and coalesce(app.ingredient_price_json(i.id, app.today()) -> 'price', 'null'::jsonb) = 'null'::jsonb
      order by i.name
    loop
      msgs := msgs || format('「%s」沒有有效單價', rec.name);
    end loop;
  end if;
  return msgs;
end
$$;

-- ───────────────────────── 試菜中可以記錄實際產量 ─────────────────────────

-- 凍結規則調整：狀態為「試菜中」時，產量相關欄位仍可修改（實際量測結果），其他內容不變
create or replace function app.guard_version_row() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '只有草案可以刪除（目前為「%」）', app.status_label(old.status) using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception '新版本一律從草案開始' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status <> 'draft' then
    if (
         old.recipe_id, old.version_no, old.title, old.change_note,
         old.prep_minutes, old.cook_minutes, old.storage_method, old.shelf_life_hours,
         old.notes, old.created_by, old.created_at
       ) is distinct from (
         new.recipe_id, new.version_no, new.title, new.change_note,
         new.prep_minutes, new.cook_minutes, new.storage_method, new.shelf_life_hours,
         new.notes, new.created_by, new.created_at
       ) then
      perform app.frozen_error(old.status);
    end if;
    -- 產量：只有「試菜中」可以改，用來記錄實際做出來的量
    if old.status <> 'testing' and (
         old.batch_output_qty, old.batch_output_unit, old.serving_qty, old.serving_unit, old.output_density_g_per_ml
       ) is distinct from (
         new.batch_output_qty, new.batch_output_unit, new.serving_qty, new.serving_unit, new.output_density_g_per_ml
       ) then
      perform app.frozen_error(old.status);
    end if;
  end if;

  if new.status is distinct from old.status and (old.status, new.status) not in (
       ('draft', 'testing'), ('draft', 'pending_approval'),
       ('testing', 'draft'), ('testing', 'pending_approval'), ('testing', 'retired'),
       ('pending_approval', 'locked'), ('pending_approval', 'testing'), ('pending_approval', 'retired'),
       ('locked', 'retired')
     ) then
    raise exception '不允許的狀態轉移：% → %', app.status_label(old.status), app.status_label(new.status)
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- 試菜中記錄實際產量（草案請用草案編輯）
create or replace function public.record_yield(p_version_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
  r app.recipes;
  v_batch numeric := nullif(p ->> 'batch_output_qty', '')::numeric;
  v_serving numeric := nullif(p ->> 'serving_qty', '')::numeric;
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('record_yield');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;
  if v.status <> 'testing' then
    raise exception '只有「試菜中」的版本可以記錄實際產量（目前為「%」）', app.status_label(v.status);
  end if;
  select * into r from app.recipes where id = v.recipe_id;

  update app.recipe_versions set
    serving_qty = v_serving,
    serving_unit = coalesce(nullif(p ->> 'serving_unit', ''), v.serving_unit, 'g'),
    batch_output_qty = case when r.type = 'dish' then v_serving else v_batch end,
    batch_output_unit = case when r.type = 'dish' then coalesce(nullif(p ->> 'serving_unit', ''), v.serving_unit, 'g')
                             else coalesce(nullif(p ->> 'batch_output_unit', ''), v.batch_output_unit, 'g') end,
    output_density_g_per_ml = nullif(p ->> 'output_density_g_per_ml', '')::numeric
  where id = v.id;
exception
  when check_violation then raise exception '產量與每份量必須大於 0';
end
$$;

-- Supabase 預設會把新函式開放給 anon，所以重跑權限設定
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from anon';
  end if;
end $$;
revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;
