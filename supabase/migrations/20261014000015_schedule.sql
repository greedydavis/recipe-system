-- 開店時間表：籌備期的前置作業（裝潢、設備、證照…）排程，畫面上是可以拖拉的甘特圖。
-- 創辦人、主廚、店長可以看也可以改；測試人員看不到。

create table app.schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  category text not null default '',
  start_date date not null,
  end_date date not null,
  is_done boolean not null default false,
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 結束日含當天：同一天開始與結束是 1 天的工作
  check (end_date >= start_date)
);
create index schedule_tasks_start on app.schedule_tasks (start_date);

alter table app.schedule_tasks enable row level security;
create trigger audit after insert or update or delete on app.schedule_tasks
  for each row execute function app.audit();
create trigger touch_updated_at before update on app.schedule_tasks
  for each row execute function app.touch_updated_at();

create or replace function public.list_schedule_tasks() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'category', s.category,
      'start_date', s.start_date, 'end_date', s.end_date,
      'is_done', s.is_done, 'note', s.note
    ) order by s.start_date, s.end_date, s.name)
    from app.schedule_tasks s
  ), '[]'::jsonb);
end
$$;

-- 新增或修改；只帶 id 和日期也可以（拖拉時只改日期）
create or replace function public.upsert_schedule_task(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_start date := nullif(p ->> 'start_date', '')::date;
  v_end date := nullif(p ->> 'end_date', '')::date;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_schedule_task');
  if v_start is null or v_end is null then raise exception '請填寫開始與結束日期'; end if;
  if v_end < v_start then raise exception '結束日期不能早於開始日期'; end if;
  if v_id is null then
    if btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫項目名稱'; end if;
    insert into app.schedule_tasks (name, category, start_date, end_date, is_done, note)
    values (btrim(p ->> 'name'), btrim(coalesce(p ->> 'category', '')), v_start, v_end,
            coalesce((p ->> 'is_done')::boolean, false), coalesce(p ->> 'note', ''))
    returning id into v_id;
  else
    if p ? 'name' and btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫項目名稱'; end if;
    update app.schedule_tasks set
      name = case when p ? 'name' then btrim(p ->> 'name') else name end,
      category = case when p ? 'category' then btrim(coalesce(p ->> 'category', '')) else category end,
      start_date = v_start,
      end_date = v_end,
      is_done = case when p ? 'is_done' then coalesce((p ->> 'is_done')::boolean, false) else is_done end,
      note = case when p ? 'note' then coalesce(p ->> 'note', '') else note end
    where id = v_id;
    if not found then raise exception '找不到此項目'; end if;
  end if;
  return v_id;
end
$$;

create or replace function public.delete_schedule_task(p_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('delete_schedule_task');
  delete from app.schedule_tasks where id = p_id;
  if not found then raise exception '找不到此項目'; end if;
end
$$;

select app.finish_migration('20261014000015');
