-- 試菜與標準食譜系統：RPC — 照片、試菜、操作紀錄、首頁、匯出

-- ───────────────────────── 照片 ─────────────────────────

create or replace function public.add_photo(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_version uuid := nullif(p ->> 'version_id', '')::uuid;
  v_step uuid := nullif(p ->> 'step_id', '')::uuid;
  v_item uuid := nullif(p ->> 'tasting_item_id', '')::uuid;
  v_id uuid;
begin
  if v_item is not null then
    perform app.require_role('founder', 'chef', 'manager');
    if not exists (select 1 from app.tasting_items where id = v_item) then raise exception '找不到此試做項目'; end if;
  else
    perform app.require_role('founder', 'chef');
  end if;
  perform app.set_context('add_photo');
  if btrim(coalesce(p ->> 'storage_path', '')) = '' then raise exception '缺少照片路徑'; end if;
  if num_nonnulls(v_version, v_step, v_item) <> 1 then raise exception '照片必須屬於版本、步驟或試做項目其中之一'; end if;
  insert into app.photos (storage_path, version_id, step_id, tasting_item_id, caption, sort_order)
  values (
    p ->> 'storage_path', v_version, v_step, v_item, coalesce(p ->> 'caption', ''),
    coalesce((
      select max(sort_order) + 1 from app.photos
      where version_id is not distinct from v_version and step_id is not distinct from v_step
        and tasting_item_id is not distinct from v_item
    ), 0)
  )
  returning id into v_id;
  return v_id;
end
$$;

-- 回傳 storage_path，讓前端刪除沒有其他紀錄引用的檔案
create or replace function public.delete_photo(p_id uuid) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := auth.uid();
  my text := app.my_role();
  ph app.photos;
begin
  if uid is null then raise exception '請先登入' using errcode = '28000'; end if;
  perform app.set_context('delete_photo');
  select * into ph from app.photos where id = p_id;
  if ph.id is null then raise exception '找不到此照片'; end if;
  if ph.tasting_item_id is not null then
    if not (my = 'founder' or (my in ('chef', 'manager') and ph.created_by = uid)) then
      raise exception '權限不足' using errcode = '42501';
    end if;
  elsif my not in ('founder', 'chef') or my is null then
    raise exception '權限不足' using errcode = '42501';
  end if;
  delete from app.photos where id = p_id;
  return jsonb_build_object(
    'storage_path', ph.storage_path,
    'still_referenced', exists (select 1 from app.photos where storage_path = ph.storage_path)
  );
end
$$;

-- 取得照片前確認可以看（測試人員只能看被指派項目的試做照）
create or replace function public.can_view_photo(p_storage_path text) returns boolean
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  my text := app.my_role();
begin
  if my in ('founder', 'chef', 'manager') then
    return exists (select 1 from app.photos where storage_path = p_storage_path);
  end if;
  if my = 'tester' then
    return exists (
      select 1 from app.photos ph join app.tasting_items ti on ti.id = ph.tasting_item_id
      where ph.storage_path = p_storage_path and auth.uid() = any (ti.assigned_tester_ids)
    );
  end if;
  return false;
end
$$;

-- Storage policy 用：誰可以上傳照片檔（寫入紀錄仍由 add_photo 檢查）
create or replace function public.can_upload_photo() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(app.my_role() in ('founder', 'chef', 'manager'), false)
$$;

-- Storage policy 用：只有已經沒有任何照片紀錄引用的檔案可以刪除
create or replace function public.can_delete_photo_file(p_storage_path text) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(app.my_role() in ('founder', 'chef', 'manager'), false)
     and not exists (select 1 from app.photos where storage_path = p_storage_path)
$$;

-- ───────────────────────── 試菜 ─────────────────────────

create or replace function app.feedback_editable(f app.tasting_feedback) returns boolean
language sql stable as $$
  select v.status <> 'retired' and (v.status <> 'locked' or f.created_at > v.approved_at)
  from app.tasting_items ti join app.recipe_versions v on v.id = ti.version_id
  where ti.id = f.tasting_item_id
$$;

create or replace function app.validate_tasting_item_payload(p jsonb) returns void
language plpgsql stable as $$
declare
  st text;
  t uuid;
begin
  select status into st from app.recipe_versions where id = nullif(p ->> 'version_id', '')::uuid;
  if st is null then raise exception '找不到要試做的版本'; end if;
  if st not in ('testing', 'pending_approval', 'locked') then
    raise exception '只有試菜中、待核准或已定版的版本可以試做（目前為「%」）', app.status_label(st);
  end if;
  for t in select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p -> 'assigned_tester_ids', '[]'::jsonb)) x loop
    if not exists (select 1 from app.profiles where id = t and is_active and role <> 'pending') then
      raise exception '指派的測試人員不存在或未啟用';
    end if;
  end loop;
end
$$;

create or replace function app.uuid_array(p jsonb) returns uuid[]
language sql immutable as $$
  select coalesce(array_agg(distinct (x #>> '{}')::uuid), '{}'::uuid[])
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x
$$;

create or replace function public.list_tasting_sessions() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'tasted_on', s.tasted_on, 'title', s.title, 'location', s.location,
      'item_count', (select count(*) from app.tasting_items ti where ti.session_id = s.id),
      'feedback_count', (
        select count(*) from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id
        where ti.session_id = s.id
      ),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('recipe_name', r.name, 'version_no', v.version_no, 'blind_label', ti.blind_label)
                         order by ti.sort_order)
        from app.tasting_items ti
        join app.recipe_versions v on v.id = ti.version_id
        join app.recipes r on r.id = v.recipe_id
        where ti.session_id = s.id
      ), '[]'::jsonb)
    ) order by s.tasted_on desc, s.created_at desc)
    from app.tasting_sessions s
  ), '[]'::jsonb);
end
$$;

create or replace function public.create_tasting_session(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  s_id uuid;
  item jsonb;
  idx int := 0;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('create_tasting_session');
  if nullif(p ->> 'tasted_on', '') is null then raise exception '請填寫試菜日期'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) = 0 then raise exception '請至少選擇一個要試做的版本'; end if;
  insert into app.tasting_sessions (tasted_on, title, location, note)
  values ((p ->> 'tasted_on')::date, coalesce(p ->> 'title', ''), coalesce(p ->> 'location', ''), coalesce(p ->> 'note', ''))
  returning id into s_id;
  for item in select * from jsonb_array_elements(p -> 'items') loop
    idx := idx + 1;
    perform app.validate_tasting_item_payload(item);
    insert into app.tasting_items (
      session_id, version_id, maker_id, maker_name, blind_label, deviation_note, assigned_tester_ids, sort_order
    ) values (
      s_id, (item ->> 'version_id')::uuid, nullif(item ->> 'maker_id', '')::uuid, coalesce(item ->> 'maker_name', ''),
      btrim(coalesce(item ->> 'blind_label', '')), coalesce(item ->> 'deviation_note', ''),
      app.uuid_array(item -> 'assigned_tester_ids'), idx
    );
  end loop;
  return s_id;
exception
  when unique_violation then raise exception '同一個場次不能重複試做同一個版本';
end
$$;

create or replace function public.update_tasting_session(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('update_tasting_session');
  update app.tasting_sessions set
    tasted_on = coalesce(nullif(p ->> 'tasted_on', '')::date, tasted_on),
    title = coalesce(p ->> 'title', ''), location = coalesce(p ->> 'location', ''), note = coalesce(p ->> 'note', '')
  where id = p_id;
  if not found then raise exception '找不到此試菜場次'; end if;
end
$$;

create or replace function public.add_tasting_item(p_session_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('add_tasting_item');
  if not exists (select 1 from app.tasting_sessions where id = p_session_id) then raise exception '找不到此試菜場次'; end if;
  perform app.validate_tasting_item_payload(p);
  insert into app.tasting_items (
    session_id, version_id, maker_id, maker_name, blind_label, deviation_note, assigned_tester_ids, sort_order
  ) values (
    p_session_id, (p ->> 'version_id')::uuid, nullif(p ->> 'maker_id', '')::uuid, coalesce(p ->> 'maker_name', ''),
    btrim(coalesce(p ->> 'blind_label', '')), coalesce(p ->> 'deviation_note', ''),
    app.uuid_array(p -> 'assigned_tester_ids'),
    coalesce((select max(sort_order) + 1 from app.tasting_items where session_id = p_session_id), 1)
  )
  returning id into v_id;
  return v_id;
exception
  when unique_violation then raise exception '這個場次已經有此版本';
end
$$;

create or replace function public.update_tasting_item(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  ti app.tasting_items;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('update_tasting_item');
  select * into ti from app.tasting_items where id = p_id for update;
  if ti.id is null then raise exception '找不到此試做項目'; end if;
  perform app.validate_tasting_item_payload(p || jsonb_build_object('version_id', ti.version_id));
  update app.tasting_items set
    maker_id = nullif(p ->> 'maker_id', '')::uuid,
    maker_name = coalesce(p ->> 'maker_name', ''),
    blind_label = btrim(coalesce(p ->> 'blind_label', '')),
    deviation_note = coalesce(p ->> 'deviation_note', ''),
    assigned_tester_ids = app.uuid_array(p -> 'assigned_tester_ids')
  where id = p_id;
end
$$;

create or replace function public.delete_tasting_item(p_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('delete_tasting_item');
  if exists (select 1 from app.tasting_feedback where tasting_item_id = p_id) then
    raise exception '已經有評分的試做項目不能刪除';
  end if;
  delete from app.tasting_items where id = p_id;
  if not found then raise exception '找不到此試做項目'; end if;
end
$$;

create or replace function app.feedback_json(f app.tasting_feedback) returns jsonb
language sql stable as $$
  select to_jsonb(f) || jsonb_build_object(
    'taster_display', coalesce(nullif(f.taster_name, ''), app.display_name(f.taster_id)),
    'entered_by_name', app.display_name(f.entered_by),
    'can_edit', app.feedback_editable(f) and (f.taster_id = auth.uid() or (f.taster_id is null and f.entered_by = auth.uid()))
  )
$$;

create or replace function public.get_tasting_session(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  s app.tasting_sessions;
begin
  perform app.require_role('founder', 'chef', 'manager');
  select * into s from app.tasting_sessions where id = p_id;
  if s.id is null then raise exception '找不到此試菜場次'; end if;
  return to_jsonb(s) || jsonb_build_object(
    'created_by_name', app.display_name(s.created_by),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ti.id, 'version_id', v.id, 'recipe_id', r.id, 'recipe_name', r.name, 'recipe_type', r.type,
        'version_no', v.version_no, 'version_title', v.title, 'version_status', v.status,
        'blind_label', ti.blind_label, 'maker_id', ti.maker_id,
        'maker_name', coalesce(app.display_name(ti.maker_id), ti.maker_name),
        'maker_name_text', ti.maker_name,
        'deviation_note', ti.deviation_note,
        'assigned_testers', coalesce((
          select jsonb_agg(jsonb_build_object('id', pr.id, 'display_name', pr.display_name) order by pr.display_name)
          from app.profiles pr where pr.id = any (ti.assigned_tester_ids)
        ), '[]'::jsonb),
        'photos', app.photos_json(null, null, ti.id),
        'feedback', coalesce((
          select jsonb_agg(app.feedback_json(f) order by f.created_at)
          from app.tasting_feedback f where f.tasting_item_id = ti.id
        ), '[]'::jsonb),
        'stats', (
          select jsonb_build_object(
            'count', count(*),
            'avg_overall', round(avg(f.score_overall), 2),
            'avg_flavor', round(avg(f.score_flavor), 2),
            'avg_texture', round(avg(f.score_texture), 2),
            'avg_aroma', round(avg(f.score_aroma), 2),
            'avg_appearance', round(avg(f.score_appearance), 2),
            'avg_saltiness', round(avg(f.saltiness), 2),
            'avg_oiliness', round(avg(f.oiliness), 2),
            'menu_ready_yes', count(*) filter (where f.menu_ready = 'yes'),
            'menu_ready_maybe', count(*) filter (where f.menu_ready = 'maybe'),
            'menu_ready_no', count(*) filter (where f.menu_ready = 'no')
          )
          from app.tasting_feedback f where f.tasting_item_id = ti.id
        )
      ) order by ti.sort_order)
      from app.tasting_items ti
      join app.recipe_versions v on v.id = ti.version_id
      join app.recipes r on r.id = v.recipe_id
      where ti.session_id = s.id
    ), '[]'::jsonb)
  );
end
$$;

-- 每個角色都可以呼叫：只回傳「指派給我」的試做項目；測試人員只看到盲測代號或菜名
create or replace function public.get_my_tasting_tasks() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  uid uuid := auth.uid();
  my text := app.my_role();
begin
  if my is null or my = 'pending' then raise exception '權限不足' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'item_id', ti.id,
      'session_id', s.id,
      'tasted_on', s.tasted_on,
      'session_title', s.title,
      'display_name', case
        when my = 'tester' then coalesce(nullif(ti.blind_label, ''), r.name)
        else r.name || ' v' || v.version_no || case when ti.blind_label <> '' then '（' || ti.blind_label || '）' else '' end
      end,
      'photos', app.photos_json(null, null, ti.id),
      'my_feedback', (
        select app.feedback_json(f) from app.tasting_feedback f where f.tasting_item_id = ti.id and f.taster_id = uid
      ),
      'can_submit', v.status <> 'retired'
    ) order by s.tasted_on desc, ti.sort_order)
    from app.tasting_items ti
    join app.tasting_sessions s on s.id = ti.session_id
    join app.recipe_versions v on v.id = ti.version_id
    join app.recipes r on r.id = v.recipe_id
    where uid = any (ti.assigned_tester_ids) and v.status <> 'retired'
  ), '[]'::jsonb);
end
$$;

create or replace function public.submit_feedback(p_item_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := auth.uid();
  my text := app.my_role();
  ti app.tasting_items;
  v_status text;
  existing app.tasting_feedback;
  proxy_name text := btrim(coalesce(p ->> 'taster_name', ''));
  f_id uuid := nullif(p ->> 'id', '')::uuid;
  k text;
begin
  if my is null or my = 'pending' then raise exception '權限不足' using errcode = '42501'; end if;
  perform app.set_context('submit_feedback');
  select * into ti from app.tasting_items where id = p_item_id;
  if ti.id is null then raise exception '找不到此試做項目'; end if;
  if my = 'tester' and not (uid = any (ti.assigned_tester_ids)) then
    raise exception '權限不足' using errcode = '42501';
  end if;
  if my = 'tester' and proxy_name <> '' then raise exception '測試人員只能填寫自己的評分' using errcode = '42501'; end if;
  select status into v_status from app.recipe_versions where id = ti.version_id;
  if v_status = 'retired' then raise exception '此版本已停用，不能再評分'; end if;

  if nullif(p ->> 'score_overall', '') is null then raise exception '請給整體分數'; end if;
  foreach k in array array['score_overall', 'score_flavor', 'score_texture', 'score_aroma', 'score_appearance'] loop
    if nullif(p ->> k, '') is not null and (p ->> k)::int not between 1 and 5 then raise exception '分數必須是 1 到 5'; end if;
  end loop;
  foreach k in array array['saltiness', 'oiliness'] loop
    if nullif(p ->> k, '') is not null and (p ->> k)::int not between -2 and 2 then raise exception '鹹淡與油膩度必須介於 -2 到 +2'; end if;
  end loop;
  if coalesce(p ->> 'menu_ready', '') not in ('', 'yes', 'maybe', 'no') then raise exception '「能不能上菜單」選項錯誤'; end if;

  if proxy_name = '' then
    select * into existing from app.tasting_feedback where tasting_item_id = ti.id and taster_id = uid for update;
  elsif f_id is not null then
    select * into existing from app.tasting_feedback where id = f_id and tasting_item_id = ti.id for update;
    if existing.id is null then raise exception '找不到此評分'; end if;
    if existing.entered_by <> uid and my <> 'founder' then raise exception '只能修改自己代填的評分' using errcode = '42501'; end if;
  end if;

  if existing.id is not null then
    if not app.feedback_editable(existing) then raise exception '版本已定版或停用，評分不能再修改'; end if;
    update app.tasting_feedback set
      taster_name = case when proxy_name <> '' then proxy_name else taster_name end,
      score_overall = (p ->> 'score_overall')::int,
      score_flavor = nullif(p ->> 'score_flavor', '')::int,
      score_texture = nullif(p ->> 'score_texture', '')::int,
      score_aroma = nullif(p ->> 'score_aroma', '')::int,
      score_appearance = nullif(p ->> 'score_appearance', '')::int,
      saltiness = nullif(p ->> 'saltiness', '')::int,
      oiliness = nullif(p ->> 'oiliness', '')::int,
      issues = coalesce(p ->> 'issues', ''),
      suggestions = coalesce(p ->> 'suggestions', ''),
      menu_ready = nullif(p ->> 'menu_ready', '')
    where id = existing.id;
    return existing.id;
  end if;

  insert into app.tasting_feedback (
    tasting_item_id, taster_id, taster_name, score_overall, score_flavor, score_texture, score_aroma,
    score_appearance, saltiness, oiliness, issues, suggestions, menu_ready
  ) values (
    ti.id, case when proxy_name = '' then uid end, proxy_name,
    (p ->> 'score_overall')::int, nullif(p ->> 'score_flavor', '')::int, nullif(p ->> 'score_texture', '')::int,
    nullif(p ->> 'score_aroma', '')::int, nullif(p ->> 'score_appearance', '')::int,
    nullif(p ->> 'saltiness', '')::int, nullif(p ->> 'oiliness', '')::int,
    coalesce(p ->> 'issues', ''), coalesce(p ->> 'suggestions', ''), nullif(p ->> 'menu_ready', '')
  )
  returning id into f_id;
  return f_id;
end
$$;

create or replace function public.delete_feedback(p_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder');
  perform app.set_context('delete_feedback');
  delete from app.tasting_feedback where id = p_id;
  if not found then raise exception '找不到此評分'; end if;
end
$$;

-- ───────────────────────── 操作紀錄 ─────────────────────────

create or replace function public.list_audit_logs(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  my text := app.my_role();
  lim int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 200);
  chef_tables text[] := array[
    'recipes', 'recipe_versions', 'recipe_lines', 'recipe_steps', 'photos', 'version_status_history',
    'cost_snapshots', 'menu_prices', 'ingredients', 'ingredient_units', 'packaging_specs', 'purchase_prices',
    'suppliers', 'tasting_sessions', 'tasting_items', 'tasting_feedback'
  ];
  rows jsonb;
begin
  if my is null or my not in ('founder', 'chef') then raise exception '權限不足' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(x order by (x ->> 'id')::bigint desc), '[]'::jsonb) into rows
  from (
    select to_jsonb(a) || jsonb_build_object('actor_name', app.display_name(a.actor_id)) as x
    from app.audit_logs a
    where (my = 'founder' or a.table_name = any (chef_tables))
      and (nullif(p ->> 'table_name', '') is null or a.table_name = p ->> 'table_name')
      and (nullif(p ->> 'record_id', '') is null or a.record_id = p ->> 'record_id')
      and (nullif(p ->> 'actor_id', '') is null or a.actor_id = (p ->> 'actor_id')::uuid)
      and (nullif(p ->> 'date_from', '') is null or a.occurred_at >= (p ->> 'date_from')::date)
      and (nullif(p ->> 'date_to', '') is null or a.occurred_at < (p ->> 'date_to')::date + 1)
      and (nullif(p ->> 'before_id', '') is null or a.id < (p ->> 'before_id')::bigint)
    order by a.id desc
    limit lim
  ) sub;
  return jsonb_build_object(
    'items', rows,
    'next_before_id', case when jsonb_array_length(rows) = lim then (rows -> -1 ->> 'id')::bigint end
  );
end
$$;

-- ───────────────────────── 首頁 ─────────────────────────

create or replace function public.get_dashboard() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  uid uuid := auth.uid();
  my text := app.my_role();
  result jsonb;
begin
  if my is null or my = 'pending' then raise exception '權限不足' using errcode = '42501'; end if;
  result := jsonb_build_object(
    'role', my,
    'my_open_tasting_tasks', (
      select count(*) from app.tasting_items ti join app.recipe_versions v on v.id = ti.version_id
      where uid = any (ti.assigned_tester_ids) and v.status <> 'retired'
        and not exists (select 1 from app.tasting_feedback f where f.tasting_item_id = ti.id and f.taster_id = uid)
    )
  );
  if my = 'tester' then return result; end if;

  return result || jsonb_build_object(
    'pending_approvals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'version_id', v.id, 'recipe_id', r.id, 'recipe_name', r.name, 'recipe_type', r.type,
        'version_no', v.version_no, 'title', v.title, 'submitted_at', v.submitted_at,
        'submitted_by_name', app.display_name(v.submitted_by)
      ) order by v.submitted_at)
      from app.recipe_versions v join app.recipes r on r.id = v.recipe_id
      where v.status = 'pending_approval'
    ), '[]'::jsonb),
    'testing_versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'version_id', v.id, 'recipe_id', r.id, 'recipe_name', r.name, 'recipe_type', r.type,
        'version_no', v.version_no, 'title', v.title, 'updated_at', v.updated_at,
        'feedback_count', (
          select count(*) from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id
          where ti.version_id = v.id
        )
      ) order by v.updated_at desc)
      from app.recipe_versions v join app.recipes r on r.id = v.recipe_id
      where v.status = 'testing' and not r.is_archived
    ), '[]'::jsonb),
    'draft_count', (
      select count(*) from app.recipe_versions v join app.recipes r on r.id = v.recipe_id
      where v.status = 'draft' and not r.is_archived
    ),
    'missing_price_ingredients', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'code', i.code) order by i.name)
      from app.ingredients i
      where i.is_active
        and exists (
          select 1 from app.recipe_lines l join app.recipe_versions v on v.id = l.version_id
          join app.recipes r on r.id = v.recipe_id
          where l.ingredient_id = i.id and v.status <> 'retired' and not r.is_archived
        )
        and coalesce(app.ingredient_price_json(i.id, app.today()) -> 'price', 'null'::jsonb) = 'null'::jsonb
    ), '[]'::jsonb),
    'outdated_references', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recipe_id', r.id, 'recipe_name', r.name, 'version_id', v.id, 'version_no', v.version_no, 'status', v.status,
        'component_name', cr.name, 'component_version_no', cv.version_no,
        'component_locked_version_no', (select x.version_no from app.recipe_versions x where x.recipe_id = cr.id and x.status = 'locked')
      ) order by r.name, v.version_no)
      from app.recipe_versions v
      join app.recipes r on r.id = v.recipe_id
      join app.recipe_lines l on l.version_id = v.id
      join app.recipe_versions cv on cv.id = l.component_version_id
      join app.recipes cr on cr.id = cv.recipe_id
      where v.status <> 'retired' and cv.status = 'retired' and not r.is_archived
    ), '[]'::jsonb),
    'recent_versions', coalesce((
      select jsonb_agg(x)
      from (
        select jsonb_build_object(
          'version_id', v.id, 'recipe_id', r.id, 'recipe_name', r.name, 'recipe_type', r.type,
          'version_no', v.version_no, 'status', v.status, 'updated_at', v.updated_at
        ) as x
        from app.recipe_versions v join app.recipes r on r.id = v.recipe_id
        order by v.updated_at desc
        limit 8
      ) sub
    ), '[]'::jsonb),
    -- 每道菜品用來判斷是否超過目標成本率的版本：現行定版，沒有定版時用最新且未停用的版本
    'dish_cost_versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recipe_id', r.id, 'recipe_name', r.name, 'version_id', pick.id, 'version_no', pick.version_no, 'status', pick.status
      ) order by r.code)
      from app.recipes r
      cross join lateral (
        select v.id, v.version_no, v.status from app.recipe_versions v
        where v.recipe_id = r.id and v.status <> 'retired'
        order by (v.status = 'locked') desc, v.version_no desc
        limit 1
      ) pick
      where r.type = 'dish' and not r.is_archived
    ), '[]'::jsonb)
  );
end
$$;

-- ───────────────────────── 匯出 ─────────────────────────

create or replace function public.export_all() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  t record;
  result jsonb := '{}'::jsonb;
  rows jsonb;
begin
  perform app.require_role('founder');
  for t in select tablename from pg_tables where schemaname = 'app' order by tablename loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from app.%I x', t.tablename) into rows;
    result := result || jsonb_build_object(t.tablename, rows);
  end loop;
  return jsonb_build_object('exported_at', now(), 'app', 'recipe-system', 'tables', result);
end
$$;
