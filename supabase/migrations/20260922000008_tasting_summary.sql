-- 試菜總結：場次層級的會議紀錄，加上每個試做項目的結論與決議
-- 對應原本 Excel 的「試菜結果」「調整方向」「下一輪？」三欄。

alter table app.tasting_sessions add column if not exists summary text not null default '';
alter table app.tasting_items add column if not exists conclusion text not null default '';
alter table app.tasting_items add column if not exists decision text
  check (decision in ('next_round', 'adjust', 'drop', 'ready'));

-- 場次：可以更新會議紀錄
create or replace function public.update_tasting_session(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('update_tasting_session');
  update app.tasting_sessions set
    tasted_on = coalesce(nullif(p ->> 'tasted_on', '')::date, tasted_on),
    title = case when p ? 'title' then coalesce(p ->> 'title', '') else title end,
    location = case when p ? 'location' then coalesce(p ->> 'location', '') else location end,
    note = case when p ? 'note' then coalesce(p ->> 'note', '') else note end,
    summary = case when p ? 'summary' then coalesce(p ->> 'summary', '') else summary end
  where id = p_id;
  if not found then raise exception '找不到此試菜場次'; end if;
end
$$;

-- 試做項目：只更新有帶到的欄位，方便分開儲存指派、偏差與結論
create or replace function public.update_tasting_item(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  ti app.tasting_items;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('update_tasting_item');
  select * into ti from app.tasting_items where id = p_id for update;
  if ti.id is null then raise exception '找不到此試做項目'; end if;
  if coalesce(p ->> 'decision', '') not in ('', 'next_round', 'adjust', 'drop', 'ready') then
    raise exception '決議選項錯誤';
  end if;
  if p ? 'assigned_tester_ids' then
    perform app.validate_tasting_item_payload(p || jsonb_build_object('version_id', ti.version_id));
  end if;

  update app.tasting_items set
    maker_id = case when p ? 'maker_id' then nullif(p ->> 'maker_id', '')::uuid else maker_id end,
    maker_name = case when p ? 'maker_name' then coalesce(p ->> 'maker_name', '') else maker_name end,
    blind_label = case when p ? 'blind_label' then btrim(coalesce(p ->> 'blind_label', '')) else blind_label end,
    deviation_note = case when p ? 'deviation_note' then coalesce(p ->> 'deviation_note', '') else deviation_note end,
    conclusion = case when p ? 'conclusion' then coalesce(p ->> 'conclusion', '') else conclusion end,
    decision = case when p ? 'decision' then nullif(p ->> 'decision', '') else decision end,
    assigned_tester_ids = case when p ? 'assigned_tester_ids' then app.uuid_array(p -> 'assigned_tester_ids') else assigned_tester_ids end
  where id = p_id;
end
$$;

-- 場次詳情：帶出會議紀錄與每個項目的結論
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
        'conclusion', ti.conclusion,
        'decision', ti.decision,
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

-- 版本頁的試菜分頁也帶出結論與決議
create or replace function public.get_version(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
  r app.recipes;
begin
  perform app.require_role('founder', 'chef', 'manager');
  select * into v from app.recipe_versions where id = p_id;
  if v.id is null then raise exception '找不到此版本'; end if;
  select * into r from app.recipes where id = v.recipe_id;
  return app.version_summary_json(v) || jsonb_build_object(
    'recipe', jsonb_build_object(
      'id', r.id, 'code', r.code, 'type', r.type, 'component_kind', r.component_kind,
      'menu_category', r.menu_category, 'name', r.name, 'is_archived', r.is_archived,
      'target_food_cost_rate', r.target_food_cost_rate
    ),
    'batch_output_qty', v.batch_output_qty, 'batch_output_unit', v.batch_output_unit,
    'serving_qty', v.serving_qty, 'serving_unit', v.serving_unit,
    'output_density_g_per_ml', v.output_density_g_per_ml,
    'prep_minutes', v.prep_minutes, 'cook_minutes', v.cook_minutes,
    'storage_method', v.storage_method, 'shelf_life_hours', v.shelf_life_hours,
    'notes', v.notes, 'revision', v.revision,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'sort_order', l.sort_order, 'group_label', l.group_label, 'line_kind', l.line_kind,
        'ingredient_id', l.ingredient_id, 'ingredient_name', i.name, 'ingredient_code', i.code,
        'component_version_id', l.component_version_id, 'component_recipe_id', cr.id,
        'component_name', cr.name, 'component_code', cr.code,
        'component_version_no', cv.version_no, 'component_status', cv.status,
        'component_locked_version_id', (select x.id from app.recipe_versions x where x.recipe_id = cr.id and x.status = 'locked'),
        'component_locked_version_no', (select x.version_no from app.recipe_versions x where x.recipe_id = cr.id and x.status = 'locked'),
        'quantity', l.quantity, 'unit', l.unit, 'waste_rate_override', l.waste_rate_override, 'prep_note', l.prep_note
      ) order by l.sort_order, l.created_at)
      from app.recipe_lines l
      left join app.ingredients i on i.id = l.ingredient_id
      left join app.recipe_versions cv on cv.id = l.component_version_id
      left join app.recipes cr on cr.id = cv.recipe_id
      where l.version_id = v.id
    ), '[]'::jsonb),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'step_no', s.step_no, 'instruction', s.instruction, 'duration_minutes', s.duration_minutes,
        'temperature_c', s.temperature_c, 'heat_level', s.heat_level, 'is_critical', s.is_critical,
        'critical_note', s.critical_note, 'photos', app.photos_json(null, s.id, null)
      ) order by s.step_no)
      from app.recipe_steps s where s.version_id = v.id
    ), '[]'::jsonb),
    'photos', app.photos_json(v.id, null, null),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'from_status', h.from_status, 'to_status', h.to_status, 'comment', h.comment,
        'actor_name', app.display_name(h.actor_id), 'created_at', h.created_at
      ) order by h.created_at desc)
      from app.version_status_history h where h.version_id = v.id
    ), '[]'::jsonb),
    'snapshots', coalesce((
      select jsonb_agg(to_jsonb(cs) - 'detail' || jsonb_build_object('created_by_name', app.display_name(cs.created_by))
                       order by cs.created_at desc)
      from app.cost_snapshots cs where cs.version_id = v.id
    ), '[]'::jsonb),
    'tastings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', ti.id, 'session_id', ts.id, 'tasted_on', ts.tasted_on, 'session_title', ts.title,
        'blind_label', ti.blind_label, 'maker_name', coalesce(app.display_name(ti.maker_id), ti.maker_name),
        'deviation_note', ti.deviation_note,
        'conclusion', ti.conclusion, 'decision', ti.decision, 'session_summary', ts.summary,
        'feedback_count', (select count(*) from app.tasting_feedback f where f.tasting_item_id = ti.id),
        'avg_overall', (select round(avg(f.score_overall), 2) from app.tasting_feedback f where f.tasting_item_id = ti.id),
        'avg_saltiness', (select round(avg(f.saltiness), 2) from app.tasting_feedback f where f.tasting_item_id = ti.id),
        'avg_oiliness', (select round(avg(f.oiliness), 2) from app.tasting_feedback f where f.tasting_item_id = ti.id),
        'issues', coalesce((
          select jsonb_agg(f.issues order by f.created_at) from app.tasting_feedback f
          where f.tasting_item_id = ti.id and btrim(f.issues) <> ''
        ), '[]'::jsonb),
        'suggestions', coalesce((
          select jsonb_agg(f.suggestions order by f.created_at) from app.tasting_feedback f
          where f.tasting_item_id = ti.id and btrim(f.suggestions) <> ''
        ), '[]'::jsonb)
      ) order by ts.tasted_on desc)
      from app.tasting_items ti join app.tasting_sessions ts on ts.id = ti.session_id
      where ti.version_id = v.id
    ), '[]'::jsonb)
  );
end
$$;

-- 場次列表：顯示有沒有寫會議紀錄、有幾項已經有決議
create or replace function public.list_tasting_sessions() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'tasted_on', s.tasted_on, 'title', s.title, 'location', s.location,
      'has_summary', btrim(s.summary) <> '',
      'item_count', (select count(*) from app.tasting_items ti where ti.session_id = s.id),
      'decided_count', (select count(*) from app.tasting_items ti where ti.session_id = s.id and ti.decision is not null),
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

-- Supabase 預設會把新函式開放給 anon，所以重跑權限設定
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from anon';
  end if;
end $$;
revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;
