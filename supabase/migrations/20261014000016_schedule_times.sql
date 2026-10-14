-- 開店時間表加上時間（選填）：例如設備 10:00 進場、驗收 14:00–16:00。
-- 沒填時間代表整天；拖拉只改日期，時間保留。

alter table app.schedule_tasks
  add column start_time time,
  add column end_time time,
  -- 同一天的項目，結束時間不能早於開始時間
  add constraint schedule_tasks_time_order
    check (start_date < end_date or start_time is null or end_time is null or end_time >= start_time);

create or replace function public.list_schedule_tasks() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'category', s.category,
      'start_date', s.start_date, 'end_date', s.end_date,
      'start_time', to_char(s.start_time, 'HH24:MI'), 'end_time', to_char(s.end_time, 'HH24:MI'),
      'is_done', s.is_done, 'note', s.note
    ) order by s.start_date, s.start_time nulls first, s.end_date, s.name)
    from app.schedule_tasks s
  ), '[]'::jsonb);
end
$$;

-- 新增或修改；只帶 id 和日期也可以（拖拉時只改日期，時間與其他欄位不變）
create or replace function public.upsert_schedule_task(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_start date := nullif(p ->> 'start_date', '')::date;
  v_end date := nullif(p ->> 'end_date', '')::date;
  v_start_time time := nullif(p ->> 'start_time', '')::time;
  v_end_time time := nullif(p ->> 'end_time', '')::time;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_schedule_task');
  if v_start is null or v_end is null then raise exception '請填寫開始與結束日期'; end if;
  if v_end < v_start then raise exception '結束日期不能早於開始日期'; end if;
  if v_id is null then
    if btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫項目名稱'; end if;
    insert into app.schedule_tasks (name, category, start_date, end_date, start_time, end_time, is_done, note)
    values (btrim(p ->> 'name'), btrim(coalesce(p ->> 'category', '')), v_start, v_end, v_start_time, v_end_time,
            coalesce((p ->> 'is_done')::boolean, false), coalesce(p ->> 'note', ''))
    returning id into v_id;
  else
    if p ? 'name' and btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫項目名稱'; end if;
    update app.schedule_tasks set
      name = case when p ? 'name' then btrim(p ->> 'name') else name end,
      category = case when p ? 'category' then btrim(coalesce(p ->> 'category', '')) else category end,
      start_date = v_start,
      end_date = v_end,
      start_time = case when p ? 'start_time' then v_start_time else start_time end,
      end_time = case when p ? 'end_time' then v_end_time else end_time end,
      is_done = case when p ? 'is_done' then coalesce((p ->> 'is_done')::boolean, false) else is_done end,
      note = case when p ? 'note' then coalesce(p ->> 'note', '') else note end
    where id = v_id;
    if not found then raise exception '找不到此項目'; end if;
  end if;
  return v_id;
exception
  when check_violation then raise exception '同一天的項目，結束時間不能早於開始時間';
end
$$;

select app.finish_migration('20261014000016');
