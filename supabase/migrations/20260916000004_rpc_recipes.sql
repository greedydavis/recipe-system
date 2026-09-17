-- 試菜與標準食譜系統：RPC — 菜品／元件、版本、狀態轉移、成本資料

-- ───────────────────────── 共用 ─────────────────────────

create or replace function app.current_menu_price(p_recipe_id uuid, p_as_of date) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', id, 'price', price, 'effective_date', effective_date)
  from app.menu_prices
  where recipe_id = p_recipe_id and effective_date <= p_as_of
  order by effective_date desc, created_at desc
  limit 1
$$;

create or replace function app.photos_json(p_version_id uuid, p_step_id uuid, p_tasting_item_id uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'storage_path', storage_path, 'caption', caption, 'sort_order', sort_order,
    'created_at', created_at, 'created_by', created_by
  ) order by sort_order, created_at), '[]'::jsonb)
  from app.photos
  where (p_version_id is not null and version_id = p_version_id)
     or (p_step_id is not null and step_id = p_step_id)
     or (p_tasting_item_id is not null and tasting_item_id = p_tasting_item_id)
$$;

create or replace function app.version_summary_json(v app.recipe_versions) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', v.id, 'recipe_id', v.recipe_id, 'version_no', v.version_no, 'title', v.title, 'status', v.status,
    'based_on_version_id', v.based_on_version_id,
    'based_on_version_no', (select b.version_no from app.recipe_versions b where b.id = v.based_on_version_id),
    'change_note', v.change_note, 'created_at', v.created_at, 'updated_at', v.updated_at,
    'created_by_name', app.display_name(v.created_by),
    'submitted_at', v.submitted_at, 'submitted_by_name', app.display_name(v.submitted_by),
    'approved_at', v.approved_at, 'approved_by_name', app.display_name(v.approved_by),
    'retired_at', v.retired_at, 'retired_by_name', app.display_name(v.retired_by), 'retire_reason', v.retire_reason,
    'superseded_by_version_id', v.superseded_by_version_id,
    'superseded_by_version_no', (select s.version_no from app.recipe_versions s where s.id = v.superseded_by_version_id),
    'tasting_item_count', (select count(*) from app.tasting_items ti where ti.version_id = v.id),
    'feedback_count', (
      select count(*) from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id
      where ti.version_id = v.id
    ),
    'avg_overall', (
      select round(avg(f.score_overall), 2) from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id
      where ti.version_id = v.id
    )
  )
$$;

create or replace function app.component_depth(p_version_id uuid) returns int
language sql stable as $$
  with recursive tree (version_id, depth) as (
    select p_version_id, 1
    union all
    select l.component_version_id, t.depth + 1
    from tree t join app.recipe_lines l on l.version_id = t.version_id
    where l.component_version_id is not null and t.depth < 10
  )
  select max(depth) from tree
$$;

-- 允許此狀態轉移的角色；不允許的轉移回傳 null（必須和 src/domain/status.ts 一致）
create or replace function app.transition_roles(p_from text, p_to text) returns text[]
language sql immutable as $$
  select case
    when (p_from, p_to) in (
      ('draft', 'testing'), ('draft', 'pending_approval'), ('testing', 'draft'),
      ('testing', 'pending_approval'), ('testing', 'retired'), ('pending_approval', 'retired')
    ) then array['founder', 'chef']
    when (p_from, p_to) in (('pending_approval', 'locked'), ('pending_approval', 'testing'), ('locked', 'retired'))
      then array['founder']
  end
$$;

-- 狀態轉移前置條件檢查；p_for：'testing' | 'approval' | 'lock'
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
  if v.serving_qty is null then msgs := msgs || '請填寫每份量'::text; end if;
  if v.batch_output_qty is null then msgs := msgs || '請填寫批次產量'::text; end if;

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

-- ───────────────────────── 菜品／元件 ─────────────────────────

create or replace function public.list_recipes(
  p_type text default null, p_q text default null, p_include_archived boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'code', r.code, 'type', r.type, 'component_kind', r.component_kind,
      'menu_category', r.menu_category, 'name', r.name, 'description', r.description,
      'is_archived', r.is_archived, 'target_food_cost_rate', r.target_food_cost_rate,
      'current_price', app.current_menu_price(r.id, app.today()),
      'locked', (
        select jsonb_build_object('id', v.id, 'version_no', v.version_no, 'title', v.title, 'approved_at', v.approved_at)
        from app.recipe_versions v where v.recipe_id = r.id and v.status = 'locked'
      ),
      'latest', (
        select jsonb_build_object('id', v.id, 'version_no', v.version_no, 'title', v.title, 'status', v.status,
                                  'updated_at', v.updated_at)
        from app.recipe_versions v where v.recipe_id = r.id order by v.version_no desc limit 1
      ),
      'version_count', (select count(*) from app.recipe_versions v where v.recipe_id = r.id),
      'has_outdated_components', exists (
        select 1 from app.recipe_versions v
        join app.recipe_lines l on l.version_id = v.id
        join app.recipe_versions cv on cv.id = l.component_version_id
        where v.recipe_id = r.id and v.status <> 'retired' and cv.status = 'retired'
      ),
      'updated_at', greatest(r.updated_at, (select max(v.updated_at) from app.recipe_versions v where v.recipe_id = r.id))
    ) order by r.code)
    from app.recipes r
    where (p_include_archived or not r.is_archived)
      and (p_type is null or r.type = p_type)
      and (
        q is null or r.name ilike '%' || q || '%' or r.code ilike '%' || q || '%' or r.menu_category ilike '%' || q || '%'
        or exists (
          select 1 from app.recipe_versions v
          join app.recipe_lines l on l.version_id = v.id
          join app.ingredients i on i.id = l.ingredient_id
          where v.recipe_id = r.id and v.status <> 'retired' and i.name ilike '%' || q || '%'
        )
      )
  ), '[]'::jsonb);
end
$$;

create or replace function public.get_recipe(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  r app.recipes;
begin
  perform app.require_role('founder', 'chef', 'manager');
  select * into r from app.recipes where id = p_id;
  if r.id is null then raise exception '找不到此食譜'; end if;
  return to_jsonb(r) || jsonb_build_object(
    'current_price', app.current_menu_price(r.id, app.today()),
    'versions', coalesce((
      select jsonb_agg(app.version_summary_json(v) order by v.version_no desc)
      from app.recipe_versions v where v.recipe_id = r.id
    ), '[]'::jsonb),
    'menu_prices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mp.id, 'price', mp.price, 'effective_date', mp.effective_date, 'note', mp.note,
        'created_at', mp.created_at, 'created_by_name', app.display_name(mp.created_by)
      ) order by mp.effective_date desc, mp.created_at desc)
      from app.menu_prices mp where mp.recipe_id = r.id
    ), '[]'::jsonb),
    'used_by', coalesce((
      select jsonb_agg(x order by x ->> 'recipe_name', (x ->> 'version_no')::int)
      from (
        select distinct jsonb_build_object(
          'recipe_id', pr.id, 'recipe_name', pr.name, 'recipe_type', pr.type,
          'version_id', pv.id, 'version_no', pv.version_no, 'status', pv.status,
          'component_version_id', cv.id, 'component_version_no', cv.version_no, 'component_status', cv.status
        ) as x
        from app.recipe_versions cv
        join app.recipe_lines l on l.component_version_id = cv.id
        join app.recipe_versions pv on pv.id = l.version_id
        join app.recipes pr on pr.id = pv.recipe_id
        where cv.recipe_id = r.id and pv.status <> 'retired'
      ) sub
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.create_recipe(p jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := app.require_role('founder', 'chef');
  v_type text := p ->> 'type';
  v_code text;
  r_id uuid;
  v_id uuid;
begin
  perform app.set_context('create_recipe');
  if v_type not in ('dish', 'component') then raise exception '請選擇菜品或元件'; end if;
  if btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫名稱'; end if;
  if v_type = 'component' and coalesce(p ->> 'component_kind', '') not in ('soup', 'sauce', 'topping', 'noodle', 'other') then
    raise exception '請選擇元件分類';
  end if;
  v_code := case v_type
    when 'dish' then 'D-' || lpad(nextval('app.dish_code_seq')::text, 3, '0')
    else 'C-' || lpad(nextval('app.component_code_seq')::text, 3, '0')
  end;
  insert into app.recipes (code, type, component_kind, menu_category, name, description, target_food_cost_rate, next_version_no)
  values (
    v_code, v_type,
    case when v_type = 'component' then p ->> 'component_kind' end,
    btrim(coalesce(p ->> 'menu_category', '')),
    btrim(p ->> 'name'),
    coalesce(p ->> 'description', ''),
    case when v_type = 'dish' then nullif(p ->> 'target_food_cost_rate', '')::numeric end,
    2
  )
  returning id into r_id;
  insert into app.recipe_versions (recipe_id, version_no, title, batch_output_unit, serving_unit)
  values (r_id, 1, coalesce(p ->> 'version_title', ''), 'g', 'g')
  returning id into v_id;
  insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
  values (v_id, null, 'draft', uid, '建立食譜');
  return jsonb_build_object('recipe_id', r_id, 'version_id', v_id);
exception
  when unique_violation then
    raise exception '已經有同名的%：%', case v_type when 'dish' then '菜品' else '元件' end, p ->> 'name';
end
$$;

create or replace function public.update_recipe(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  r app.recipes;
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('update_recipe');
  select * into r from app.recipes where id = p_id for update;
  if r.id is null then raise exception '找不到此食譜'; end if;
  if btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫名稱'; end if;
  update app.recipes set
    name = btrim(p ->> 'name'),
    description = coalesce(p ->> 'description', ''),
    menu_category = btrim(coalesce(p ->> 'menu_category', '')),
    component_kind = case when r.type = 'component' then coalesce(nullif(p ->> 'component_kind', ''), r.component_kind) end,
    target_food_cost_rate = case when r.type = 'dish' then nullif(p ->> 'target_food_cost_rate', '')::numeric end
  where id = p_id;
exception
  when unique_violation then raise exception '已經有同名的食譜：%', p ->> 'name';
  when check_violation then raise exception '目標食材成本率必須介於 0%% 與 100%% 之間';
end
$$;

create or replace function public.set_recipe_archived(p_id uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('set_recipe_archived');
  update app.recipes set is_archived = p_archived where id = p_id;
  if not found then raise exception '找不到此食譜'; end if;
end
$$;

create or replace function public.set_menu_price(
  p_recipe_id uuid, p_price numeric, p_effective_date date, p_note text default ''
) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_role('founder');
  perform app.set_context('set_menu_price');
  if not exists (select 1 from app.recipes where id = p_recipe_id and type = 'dish') then
    raise exception '只有菜品可以設定售價';
  end if;
  if p_price is null or p_price <= 0 or p_price <> round(p_price) then raise exception '售價必須是大於 0 的整數'; end if;
  if p_effective_date is null then raise exception '請填寫生效日'; end if;
  insert into app.menu_prices (recipe_id, price, effective_date, note)
  values (p_recipe_id, p_price, p_effective_date, coalesce(p_note, ''))
  returning id into v_id;
  return v_id;
end
$$;

-- ───────────────────────── 版本 ─────────────────────────

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

create or replace function public.save_version_draft(p_version_id uuid, p_revision int, p jsonb) returns int
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
  r app.recipes;
  cv app.recipe_versions;
  cr app.recipes;
  line jsonb;
  step jsonb;
  keep_ids uuid[];
  row_id uuid;
  idx int := 0;
  v_ing uuid;
  v_qty numeric;
  v_waste numeric;
  new_revision int;
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('save_version_draft');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;
  if v.status <> 'draft' then perform app.frozen_error(v.status); end if;
  if v.revision <> p_revision then
    raise exception '這份草案已經被其他人更新，請重新載入後再修改' using errcode = '40001';
  end if;
  select * into r from app.recipes where id = v.recipe_id;

  update app.recipe_versions set
    title = coalesce(p ->> 'title', ''),
    change_note = coalesce(p ->> 'change_note', ''),
    serving_qty = nullif(p ->> 'serving_qty', '')::numeric,
    serving_unit = coalesce(nullif(p ->> 'serving_unit', ''), 'g'),
    batch_output_qty = case when r.type = 'dish' then nullif(p ->> 'serving_qty', '')::numeric
                            else nullif(p ->> 'batch_output_qty', '')::numeric end,
    batch_output_unit = case when r.type = 'dish' then coalesce(nullif(p ->> 'serving_unit', ''), 'g')
                             else coalesce(nullif(p ->> 'batch_output_unit', ''), 'g') end,
    output_density_g_per_ml = nullif(p ->> 'output_density_g_per_ml', '')::numeric,
    prep_minutes = nullif(p ->> 'prep_minutes', '')::numeric,
    cook_minutes = nullif(p ->> 'cook_minutes', '')::numeric,
    storage_method = coalesce(p ->> 'storage_method', ''),
    shelf_life_hours = nullif(p ->> 'shelf_life_hours', '')::int,
    notes = coalesce(p ->> 'notes', ''),
    revision = revision + 1
  where id = v.id
  returning revision into new_revision;

  -- 用料：依 id 新增／更新，未出現在 payload 的刪除
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into keep_ids
  from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x
  where nullif(x ->> 'id', '') is not null;
  delete from app.recipe_lines where version_id = v.id and not (id = any (keep_ids));

  for line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    idx := idx + 1;
    row_id := coalesce(nullif(line ->> 'id', '')::uuid, gen_random_uuid());
    if exists (select 1 from app.recipe_lines where id = row_id and version_id <> v.id) then
      raise exception '第 % 行用料資料有誤，請重新載入', idx;
    end if;
    v_qty := nullif(line ->> 'quantity', '')::numeric;
    v_waste := nullif(line ->> 'waste_rate_override', '')::numeric;
    if v_qty is not null and v_qty <= 0 then raise exception '第 % 行：用量必須大於 0', idx; end if;
    if v_waste is not null and (v_waste < 0 or v_waste >= 1) then
      raise exception '第 % 行：損耗率必須介於 0%% 與 100%% 之間（不含 100%%）', idx;
    end if;

    if line ->> 'line_kind' = 'ingredient' then
      v_ing := nullif(line ->> 'ingredient_id', '')::uuid;
      if v_ing is null or not exists (select 1 from app.ingredients where id = v_ing) then
        raise exception '第 % 行：找不到原物料', idx;
      end if;
      if not app.is_valid_ingredient_unit(v_ing, line ->> 'unit') then
        raise exception '第 % 行：單位「%」不適用於此原物料', idx, coalesce(line ->> 'unit', '');
      end if;
      cv := null;
    elsif line ->> 'line_kind' = 'component' then
      v_ing := null;
      select * into cv from app.recipe_versions where id = nullif(line ->> 'component_version_id', '')::uuid;
      if cv.id is null then raise exception '第 % 行：找不到元件版本', idx; end if;
      select * into cr from app.recipes where id = cv.recipe_id;
      if cr.type <> 'component' then raise exception '第 % 行：只能引用元件', idx; end if;
      if cr.id = r.id then raise exception '第 % 行：不能引用自己的食譜', idx; end if;
      -- 既有且未變更的引用可以保留（例如複製後被取代的舊版元件），但新引用必須是已凍結的版本
      if cv.status not in ('testing', 'pending_approval', 'locked')
         and not exists (select 1 from app.recipe_lines where id = row_id and component_version_id = cv.id) then
        raise exception '第 % 行：「%」v% 為「%」，只能引用試菜中、待核准或已定版的元件版本',
          idx, cr.name, cv.version_no, app.status_label(cv.status);
      end if;
      if coalesce(line ->> 'unit', '') not in ('g', 'kg', '台斤', '兩', 'ml', 'L', '份') then
        raise exception '第 % 行：元件用量單位必須是重量、容量或「份」', idx;
      end if;
      if app.component_depth(cv.id) + 1 > 5 then raise exception '第 % 行：元件巢狀超過 5 層', idx; end if;
    else
      raise exception '第 % 行：用料類型錯誤', idx;
    end if;

    insert into app.recipe_lines (
      id, version_id, sort_order, group_label, line_kind, ingredient_id, component_version_id,
      quantity, unit, waste_rate_override, prep_note
    ) values (
      row_id, v.id, idx, btrim(coalesce(line ->> 'group_label', '')), line ->> 'line_kind', v_ing, cv.id,
      v_qty, line ->> 'unit', v_waste, coalesce(line ->> 'prep_note', '')
    )
    on conflict (id) do update set
      sort_order = excluded.sort_order, group_label = excluded.group_label, line_kind = excluded.line_kind,
      ingredient_id = excluded.ingredient_id, component_version_id = excluded.component_version_id,
      quantity = excluded.quantity, unit = excluded.unit, waste_rate_override = excluded.waste_rate_override,
      prep_note = excluded.prep_note;
  end loop;

  -- 步驟
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into keep_ids
  from jsonb_array_elements(coalesce(p -> 'steps', '[]'::jsonb)) x
  where nullif(x ->> 'id', '') is not null;
  delete from app.recipe_steps where version_id = v.id and not (id = any (keep_ids));

  idx := 0;
  for step in select * from jsonb_array_elements(coalesce(p -> 'steps', '[]'::jsonb)) loop
    idx := idx + 1;
    row_id := coalesce(nullif(step ->> 'id', '')::uuid, gen_random_uuid());
    if exists (select 1 from app.recipe_steps where id = row_id and version_id <> v.id) then
      raise exception '第 % 個步驟資料有誤，請重新載入', idx;
    end if;
    if coalesce(step ->> 'heat_level', '') not in ('', 'high', 'medium', 'low', 'simmer') then
      raise exception '第 % 個步驟：火力設定錯誤', idx;
    end if;
    insert into app.recipe_steps (
      id, version_id, step_no, instruction, duration_minutes, temperature_c, heat_level, is_critical, critical_note
    ) values (
      row_id, v.id, idx, coalesce(step ->> 'instruction', ''),
      nullif(step ->> 'duration_minutes', '')::numeric, nullif(step ->> 'temperature_c', '')::numeric,
      nullif(step ->> 'heat_level', ''), coalesce((step ->> 'is_critical')::boolean, false),
      coalesce(step ->> 'critical_note', '')
    )
    on conflict (id) do update set
      step_no = excluded.step_no, instruction = excluded.instruction, duration_minutes = excluded.duration_minutes,
      temperature_c = excluded.temperature_c, heat_level = excluded.heat_level, is_critical = excluded.is_critical,
      critical_note = excluded.critical_note;
  end loop;

  return new_revision;
end
$$;

create or replace function public.copy_version(p_source_id uuid, p_change_note text default '') returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := app.require_role('founder', 'chef');
  src app.recipe_versions;
  new_id uuid;
  new_no int;
  s app.recipe_steps;
  new_step uuid;
begin
  perform app.set_context('copy_version');
  select * into src from app.recipe_versions where id = p_source_id;
  if src.id is null then raise exception '找不到此版本'; end if;

  update app.recipes set next_version_no = next_version_no + 1
  where id = src.recipe_id
  returning next_version_no - 1 into new_no;

  insert into app.recipe_versions (
    recipe_id, version_no, title, based_on_version_id, change_note, batch_output_qty, batch_output_unit,
    serving_qty, serving_unit, output_density_g_per_ml, prep_minutes, cook_minutes, storage_method,
    shelf_life_hours, notes
  ) values (
    src.recipe_id, new_no, src.title, src.id, coalesce(p_change_note, ''), src.batch_output_qty, src.batch_output_unit,
    src.serving_qty, src.serving_unit, src.output_density_g_per_ml, src.prep_minutes, src.cook_minutes,
    src.storage_method, src.shelf_life_hours, src.notes
  )
  returning id into new_id;

  insert into app.recipe_lines (
    version_id, sort_order, group_label, line_kind, ingredient_id, component_version_id, quantity, unit,
    waste_rate_override, prep_note
  )
  select new_id, sort_order, group_label, line_kind, ingredient_id, component_version_id, quantity, unit,
         waste_rate_override, prep_note
  from app.recipe_lines where version_id = src.id;

  for s in select * from app.recipe_steps where version_id = src.id order by step_no loop
    insert into app.recipe_steps (
      version_id, step_no, instruction, duration_minutes, temperature_c, heat_level, is_critical, critical_note
    ) values (
      new_id, s.step_no, s.instruction, s.duration_minutes, s.temperature_c, s.heat_level, s.is_critical, s.critical_note
    )
    returning id into new_step;
    insert into app.photos (storage_path, step_id, caption, sort_order)
    select storage_path, new_step, caption, sort_order from app.photos where step_id = s.id;
  end loop;

  insert into app.photos (storage_path, version_id, caption, sort_order)
  select storage_path, new_id, caption, sort_order from app.photos where version_id = src.id;

  insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
  values (new_id, null, 'draft', uid,
          '複製自 v' || src.version_no || case when btrim(coalesce(p_change_note, '')) <> '' then '：' || btrim(p_change_note) else '' end);
  return new_id;
end
$$;

create or replace function public.delete_draft(p_version_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('delete_draft');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;
  if v.status <> 'draft' then raise exception '只有草案可以刪除'; end if;
  if (select count(*) from app.recipe_versions where recipe_id = v.recipe_id) <= 1 then
    raise exception '食譜至少要保留一個版本；不需要的話可以封存食譜';
  end if;
  delete from app.recipe_versions where id = v.id;
end
$$;

create or replace function public.transition_version(
  p_version_id uuid, p_to text, p_comment text default '', p_snapshot jsonb default null
) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := auth.uid();
  my text := app.my_role();
  v app.recipe_versions;
  prev app.recipe_versions;
  roles text[];
  blockers text[] := '{}';
  c text := btrim(coalesce(p_comment, ''));
begin
  if uid is null then raise exception '請先登入' using errcode = '28000'; end if;
  perform app.set_context('transition_version');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;

  roles := app.transition_roles(v.status, p_to);
  if roles is null then
    raise exception '不允許的狀態轉移：% → %', app.status_label(v.status), app.status_label(p_to) using errcode = '42501';
  end if;
  if my is null or not (my = any (roles)) then
    raise exception '權限不足' using errcode = '42501';
  end if;

  if c = '' then
    if v.status = 'draft' and p_to = 'pending_approval' then raise exception '請填寫免試菜原因'; end if;
    if v.status = 'testing' and p_to = 'pending_approval' then raise exception '請填寫送審說明'; end if;
    if v.status = 'pending_approval' and p_to = 'testing' then raise exception '請填寫退回原因'; end if;
    if p_to = 'retired' then raise exception '請填寫停用原因'; end if;
  end if;

  if p_to = 'testing' and v.status = 'draft' then
    blockers := app.version_blockers(v.id, 'testing');
  elsif p_to = 'pending_approval' then
    blockers := app.version_blockers(v.id, 'approval');
    if v.status = 'testing'
       and (select value from app.app_settings where key = 'require_tasting_before_approval') = 'true'::jsonb
       and not exists (
         select 1 from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id
         where ti.version_id = v.id
       ) then
      blockers := blockers || '尚未有試吃評分（系統設定要求送核准前要有試菜紀錄）'::text;
    end if;
  elsif p_to = 'draft' then
    if exists (select 1 from app.tasting_items where version_id = v.id) then
      blockers := blockers || '已經有試做項目，不能退回草案；請複製為新版本'::text;
    end if;
    if exists (select 1 from app.recipe_lines where component_version_id = v.id) then
      blockers := blockers || '已被其他食譜版本引用，不能退回草案'::text;
    end if;
  elsif p_to = 'locked' then
    blockers := app.version_blockers(v.id, 'lock');
    if p_snapshot is null then
      blockers := blockers || '缺少成本快照'::text;
    elsif coalesce((p_snapshot ->> 'is_complete')::boolean, false) is not true then
      blockers := blockers || '成本不完整，不能定版'::text;
    end if;
  end if;

  if coalesce(array_length(blockers, 1), 0) > 0 then
    raise exception '無法變更狀態：%', array_to_string(blockers, '；');
  end if;

  if p_to = 'locked' then
    select * into prev from app.recipe_versions where recipe_id = v.recipe_id and status = 'locked' for update;
    if prev.id is not null then
      update app.recipe_versions set
        status = 'retired', retired_at = now(), retired_by = null,
        retire_reason = '被 v' || v.version_no || ' 取代', superseded_by_version_id = v.id
      where id = prev.id;
      insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
      values (prev.id, 'locked', 'retired', null, '被 v' || v.version_no || ' 取代');
    end if;
    insert into app.cost_snapshots (
      version_id, reason, price_as_of, batch_cost, cost_per_serving, yield_rate, menu_price, food_cost_rate, is_complete, detail
    ) values (
      v.id, 'lock', app.today(),
      nullif(p_snapshot ->> 'batch_cost', '')::numeric,
      nullif(p_snapshot ->> 'cost_per_serving', '')::numeric,
      nullif(p_snapshot ->> 'yield_rate', '')::numeric,
      nullif(p_snapshot ->> 'menu_price', '')::numeric,
      nullif(p_snapshot ->> 'food_cost_rate', '')::numeric,
      true,
      coalesce(p_snapshot -> 'detail', '{}'::jsonb)
    );
  end if;

  update app.recipe_versions set
    status = p_to,
    submitted_by = case when p_to = 'pending_approval' then uid else submitted_by end,
    submitted_at = case when p_to = 'pending_approval' then now() else submitted_at end,
    approved_by = case when p_to = 'locked' then uid else approved_by end,
    approved_at = case when p_to = 'locked' then now() else approved_at end,
    retired_by = case when p_to = 'retired' then uid else retired_by end,
    retired_at = case when p_to = 'retired' then now() else retired_at end,
    retire_reason = case when p_to = 'retired' then c else retire_reason end
  where id = v.id;

  insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
  values (v.id, v.status, p_to, uid, c);

  return jsonb_build_object('id', v.id, 'status', p_to);
end
$$;

-- 計算成本所需的全部資料（含巢狀元件版本）
create or replace function public.get_costing_bundle(p_version_ids uuid[], p_as_of date default null) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  as_of date := coalesce(p_as_of, app.today());
  all_ids uuid[];
begin
  perform app.require_role('founder', 'chef', 'manager');
  with recursive tree (id) as (
    select unnest(coalesce(p_version_ids, '{}'::uuid[]))
    union
    select l.component_version_id
    from tree t join app.recipe_lines l on l.version_id = t.id
    where l.component_version_id is not null
  )
  select array_agg(id) into all_ids from tree;

  return jsonb_build_object(
    'as_of', as_of,
    'settings', (select jsonb_object_agg(key, value) from app.app_settings),
    'versions', coalesce((
      select jsonb_object_agg(v.id, jsonb_build_object(
        'id', v.id, 'recipe_id', r.id, 'recipe_type', r.type, 'recipe_name', r.name, 'recipe_code', r.code,
        'version_no', v.version_no, 'status', v.status,
        'batch_output_qty', v.batch_output_qty, 'batch_output_unit', v.batch_output_unit,
        'serving_qty', v.serving_qty, 'serving_unit', v.serving_unit,
        'output_density_g_per_ml', v.output_density_g_per_ml,
        'menu_price', app.current_menu_price(r.id, as_of),
        'target_food_cost_rate', r.target_food_cost_rate,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', l.id, 'line_kind', l.line_kind, 'ingredient_id', l.ingredient_id,
            'component_version_id', l.component_version_id, 'quantity', l.quantity, 'unit', l.unit,
            'waste_rate_override', l.waste_rate_override, 'group_label', l.group_label,
            'prep_note', l.prep_note, 'sort_order', l.sort_order
          ) order by l.sort_order)
          from app.recipe_lines l where l.version_id = v.id
        ), '[]'::jsonb)
      ))
      from app.recipe_versions v join app.recipes r on r.id = v.recipe_id
      where v.id = any (all_ids)
    ), '{}'::jsonb),
    'ingredients', coalesce((
      select jsonb_object_agg(i.id, app.ingredient_json(i, as_of))
      from app.ingredients i
      where i.id in (select l.ingredient_id from app.recipe_lines l where l.version_id = any (all_ids))
    ), '{}'::jsonb)
  );
end
$$;
