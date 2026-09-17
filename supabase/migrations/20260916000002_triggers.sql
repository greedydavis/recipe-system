-- 試菜與標準食譜系統：共用函式與資料庫層強制規則（凍結、稽核、只增不改）

-- ───────────────────────── 共用函式 ─────────────────────────

create or replace function app.today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Taipei')::date
$$;

create or replace function app.status_label(s text) returns text
language sql immutable as $$
  select case s
    when 'draft' then '草案'
    when 'testing' then '試菜中'
    when 'pending_approval' then '待核准'
    when 'locked' then '已定版'
    when 'retired' then '停用'
    else coalesce(s, '（無）')
  end
$$;

-- 目前登入者的角色（停用或不存在時為 null）
create or replace function app.my_role() returns text
language sql stable security definer set search_path = app, pg_temp as $$
  select role from app.profiles where id = auth.uid() and is_active
$$;

-- 驗證角色，通過時回傳 user id
create or replace function app.require_role(variadic roles text[]) returns uuid
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  uid uuid := auth.uid();
  r text;
begin
  if uid is null then
    raise exception '請先登入' using errcode = '28000';
  end if;
  select role into r from app.profiles where id = uid and is_active;
  if r is null or not (r = any (roles)) then
    raise exception '權限不足' using errcode = '42501';
  end if;
  return uid;
end
$$;

create or replace function app.display_name(p_id uuid) returns text
language sql stable security definer set search_path = app, pg_temp as $$
  select display_name from app.profiles where id = p_id
$$;

create or replace function app.set_context(p_context text) returns void
language sql as $$
  select set_config('app.context', p_context, true)
$$;

-- ───────────────────────── updated_at ─────────────────────────

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare t record;
begin
  for t in
    select c.table_name from information_schema.columns c
    where c.table_schema = 'app' and c.column_name = 'updated_at'
  loop
    execute format(
      'create trigger touch_updated_at before update on app.%I for each row execute function app.touch_updated_at()',
      t.table_name);
  end loop;
end $$;

-- ───────────────────────── 操作紀錄 ─────────────────────────

create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  o jsonb;
  n jsonb;
  changed text[];
begin
  if tg_op in ('UPDATE', 'DELETE') then o := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then n := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into changed
    from jsonb_object_keys(n) as k
    where k not in ('updated_at', 'revision') and (o -> k) is distinct from (n -> k);
    if changed is null then
      return null;
    end if;
  end if;
  insert into app.audit_logs (actor_id, action, table_name, record_id, old_data, new_data, changed_fields, context)
  values (
    auth.uid(), lower(tg_op), tg_table_name,
    coalesce(n ->> 'id', o ->> 'id', n ->> 'key', o ->> 'key'),
    o, n, changed, nullif(current_setting('app.context', true), '')
  );
  return null;
end
$$;

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' and tablename <> 'audit_logs' loop
    execute format(
      'create trigger audit after insert or update or delete on app.%I for each row execute function app.audit()',
      t.tablename);
  end loop;
end $$;

create or replace function app.reject_change() returns trigger
language plpgsql as $$
begin
  raise exception '%', tg_argv[0] using errcode = '42501';
end
$$;

create trigger audit_logs_append_only before update or delete on app.audit_logs
  for each row execute function app.reject_change('操作紀錄只能新增，不能修改或刪除');

create trigger status_history_append_only before update on app.version_status_history
  for each row execute function app.reject_change('狀態歷程不能修改');

create trigger cost_snapshots_append_only before update on app.cost_snapshots
  for each row execute function app.reject_change('成本快照不能修改');

-- ───────────────────────── 單價只增不改 ─────────────────────────

create or replace function app.guard_purchase_price() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '單價紀錄不能刪除，請改用作廢' using errcode = '42501';
  end if;
  if (old.packaging_spec_id, old.price, old.effective_date, old.note, old.created_by, old.created_at)
     is distinct from
     (new.packaging_spec_id, new.price, new.effective_date, new.note, new.created_by, new.created_at) then
    raise exception '單價紀錄不能修改，請作廢後新增一筆' using errcode = '42501';
  end if;
  if old.is_void and not new.is_void then
    raise exception '已作廢的單價不能恢復' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger guard_purchase_price before update or delete on app.purchase_prices
  for each row execute function app.guard_purchase_price();

-- ───────────────────────── 版本凍結 ─────────────────────────

create or replace function app.frozen_error(p_status text) returns void
language plpgsql as $$
begin
  raise exception '此版本為「%」，內容已凍結不能修改；請複製為新版本', app.status_label(p_status)
    using errcode = '42501';
end
$$;

-- recipe_lines、recipe_steps：只有草案可以新增、修改、刪除
create or replace function app.guard_version_child() returns trigger
language plpgsql as $$
declare
  st text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status into st from app.recipe_versions where id = old.version_id;
    if st is not null and st <> 'draft' then perform app.frozen_error(st); end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into st from app.recipe_versions where id = new.version_id;
    if st is not null and st <> 'draft' then perform app.frozen_error(st); end if;
  end if;
  return coalesce(new, old);
end
$$;

create trigger guard_frozen before insert or update or delete on app.recipe_lines
  for each row execute function app.guard_version_child();
create trigger guard_frozen before insert or update or delete on app.recipe_steps
  for each row execute function app.guard_version_child();

-- photos：成品照與步驟照跟著版本凍結；試做照不凍結
create or replace function app.photo_version_status(p_version_id uuid, p_step_id uuid) returns text
language sql stable as $$
  select v.status
  from app.recipe_versions v
  where v.id = coalesce(p_version_id, (select s.version_id from app.recipe_steps s where s.id = p_step_id))
$$;

create or replace function app.guard_photo() returns trigger
language plpgsql as $$
declare
  st text;
begin
  if tg_op in ('UPDATE', 'DELETE') and (old.version_id is not null or old.step_id is not null) then
    st := app.photo_version_status(old.version_id, old.step_id);
    if st is not null and st <> 'draft' then perform app.frozen_error(st); end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (new.version_id is not null or new.step_id is not null) then
    st := app.photo_version_status(new.version_id, new.step_id);
    if st is not null and st <> 'draft' then perform app.frozen_error(st); end if;
  end if;
  return coalesce(new, old);
end
$$;

create trigger guard_frozen before insert or update or delete on app.photos
  for each row execute function app.guard_photo();

-- recipe_versions：非草案不能改內容、不能刪除；狀態只能照轉移表變更
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

  if old.status <> 'draft' and (
       old.recipe_id, old.version_no, old.title, old.change_note,
       old.batch_output_qty, old.batch_output_unit, old.serving_qty, old.serving_unit,
       old.output_density_g_per_ml, old.prep_minutes, old.cook_minutes,
       old.storage_method, old.shelf_life_hours, old.notes, old.created_by, old.created_at
     ) is distinct from (
       new.recipe_id, new.version_no, new.title, new.change_note,
       new.batch_output_qty, new.batch_output_unit, new.serving_qty, new.serving_unit,
       new.output_density_g_per_ml, new.prep_minutes, new.cook_minutes,
       new.storage_method, new.shelf_life_hours, new.notes, new.created_by, new.created_at
     ) then
    perform app.frozen_error(old.status);
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

create trigger guard_version_row before insert or update or delete on app.recipe_versions
  for each row execute function app.guard_version_row();

-- ───────────────────────── 新帳號 ─────────────────────────

-- 第一個註冊的帳號自動成為創辦人；其餘帳號為待審核
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  insert into app.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, ''), '@', 1)),
    case when exists (select 1 from app.profiles where role = 'founder') then 'pending' else 'founder' end
  );
  return new;
end
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();
