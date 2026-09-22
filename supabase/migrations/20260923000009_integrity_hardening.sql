-- 試菜與標準食譜系統：資料完整性強化
-- 定版成本由資料庫重算；試菜回饋、歷程與元件引用在資料庫層強制保護。

-- ───────────────────────── 單位與成本快照 ─────────────────────────

create or replace function app.ingredient_qty_in_base(p_qty numeric, p_unit text, p_ingredient app.ingredients) returns numeric
language plpgsql stable set search_path = app, pg_temp as $$
declare
  custom_qty numeric;
  u app.units;
  q numeric;
begin
  if p_qty is null or p_qty <= 0 then return null; end if;
  select qty_in_base into custom_qty
  from app.ingredient_units
  where ingredient_id = p_ingredient.id and unit_name = p_unit;
  if found then return p_qty * custom_qty; end if;

  select * into u from app.units where code = p_unit;
  if u.code is null then return null; end if;
  q := p_qty * u.factor_to_base;
  if u.dimension = p_ingredient.base_dimension then return q; end if;
  if u.dimension = 'mass' and p_ingredient.base_dimension = 'volume' and p_ingredient.density_g_per_ml is not null then
    return q / p_ingredient.density_g_per_ml;
  end if;
  if u.dimension = 'volume' and p_ingredient.base_dimension = 'mass' and p_ingredient.density_g_per_ml is not null then
    return q * p_ingredient.density_g_per_ml;
  end if;
  return null;
end
$$;

create or replace function app.component_qty_in_output(p_qty numeric, p_unit text, p_version app.recipe_versions) returns numeric
language plpgsql stable set search_path = app, pg_temp as $$
declare
  u app.units;
  q numeric := p_qty;
  source_unit text := p_unit;
  source_dimension text;
  target_dimension text;
begin
  if p_qty is null or p_qty <= 0 or p_version.batch_output_unit is null then return null; end if;
  if p_unit = '份' then
    if p_version.serving_qty is null or p_version.serving_unit is null then return null; end if;
    q := p_qty * p_version.serving_qty;
    source_unit := p_version.serving_unit;
  end if;
  select * into u from app.units where code = source_unit;
  if u.code is null or u.dimension = 'count' then return null; end if;
  q := q * u.factor_to_base;
  source_dimension := u.dimension;
  target_dimension := case when p_version.batch_output_unit = 'g' then 'mass' else 'volume' end;
  if source_dimension = target_dimension then return q; end if;
  if source_dimension = 'mass' and target_dimension = 'volume' and p_version.output_density_g_per_ml is not null then
    return q / p_version.output_density_g_per_ml;
  end if;
  if source_dimension = 'volume' and target_dimension = 'mass' and p_version.output_density_g_per_ml is not null then
    return q * p_version.output_density_g_per_ml;
  end if;
  return null;
end
$$;

create or replace function app.server_cost_snapshot(p_version_id uuid, p_as_of date default null) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
  r app.recipes;
  l record;
  i app.ingredients;
  cv app.recipe_versions;
  cr app.recipes;
  spec record;
  component_snapshot app.cost_snapshots;
  as_of date := coalesce(p_as_of, app.today());
  base_qty numeric;
  purchase_qty numeric;
  pack_base_qty numeric;
  unit_cost numeric;
  line_cost numeric;
  waste_rate numeric;
  component_qty numeric;
  component_unit_cost numeric;
  gram_weight numeric;
  known_cost numeric := 0;
  input_weight_g numeric := 0;
  output_weight_g numeric;
  batch_cost numeric;
  serving_cost numeric;
  yield_rate numeric;
  menu_price numeric;
  food_cost_rate numeric;
  target_rate numeric;
  tax_rate numeric;
  issues text[] := '{}';
  line_issues text[];
  details jsonb := '[]'::jsonb;
  serving_in_output numeric;
begin
  select * into v from app.recipe_versions where id = p_version_id;
  if v.id is null then raise exception '找不到此版本'; end if;
  select * into r from app.recipes where id = v.recipe_id;

  for l in select * from app.recipe_lines where version_id = v.id order by sort_order, created_at loop
    base_qty := null; purchase_qty := null; unit_cost := null; line_cost := null; gram_weight := null;
    line_issues := '{}';
    if l.line_kind = 'ingredient' then
      select * into i from app.ingredients where id = l.ingredient_id;
      base_qty := app.ingredient_qty_in_base(l.quantity, l.unit, i);
      if base_qty is null then line_issues := line_issues || format('「%s」的用量或單位無法換算', i.name); end if;
      waste_rate := coalesce(l.waste_rate_override, i.default_waste_rate);
      if waste_rate < 0 or waste_rate >= 1 then line_issues := line_issues || format('「%s」損耗率不正確', i.name); end if;
      select s.id as spec_id, s.spec_name, s.pack_qty, s.pack_unit, pp.id as price_id, pp.price
      into spec
      from app.packaging_specs s
      left join lateral (
        select id, price from app.purchase_prices
        where packaging_spec_id = s.id and not is_void and effective_date <= as_of
        order by effective_date desc, created_at desc limit 1
      ) pp on true
      where s.ingredient_id = i.id and s.is_default
      limit 1;
      if spec.spec_id is null then
        line_issues := line_issues || format('「%s」沒有預設包裝規格', i.name);
      elsif spec.price_id is null then
        line_issues := line_issues || format('「%s」沒有有效單價', i.name);
      else
        pack_base_qty := app.ingredient_qty_in_base(spec.pack_qty, spec.pack_unit, i);
        if pack_base_qty is null or pack_base_qty <= 0 then
          line_issues := line_issues || format('「%s」的包裝規格無法換算', i.name);
        else
          unit_cost := spec.price / pack_base_qty;
        end if;
      end if;
      if base_qty is not null and unit_cost is not null and waste_rate >= 0 and waste_rate < 1 then
        purchase_qty := base_qty / (1 - waste_rate);
        line_cost := purchase_qty * unit_cost;
      end if;
      if i.base_dimension = 'mass' then gram_weight := base_qty;
      elsif i.base_dimension = 'volume' and i.density_g_per_ml is not null and base_qty is not null then gram_weight := base_qty * i.density_g_per_ml;
      end if;
      details := details || jsonb_build_array(jsonb_build_object(
        'line_id', l.id, 'kind', 'ingredient', 'name', i.name, 'quantity', l.quantity, 'unit', l.unit,
        'base_qty', base_qty, 'base_unit', case i.base_dimension when 'mass' then 'g' when 'volume' then 'ml' else 'pc' end,
        'waste_rate', waste_rate, 'purchase_qty', purchase_qty, 'unit_cost', unit_cost, 'cost', line_cost,
        'purchase_price_id', spec.price_id, 'component_version_id', null
      ));
    else
      select * into cv from app.recipe_versions where id = l.component_version_id;
      select * into cr from app.recipes where id = cv.recipe_id;
      select * into component_snapshot from app.cost_snapshots
      where version_id = cv.id and reason = 'lock' order by created_at desc limit 1;
      component_qty := app.component_qty_in_output(l.quantity, l.unit, cv);
      if component_qty is null then line_issues := line_issues || format('元件「%s」v%s 的用量或單位無法換算', cr.name, cv.version_no); end if;
      if component_snapshot.id is null or not component_snapshot.is_complete or component_snapshot.batch_cost is null or cv.batch_output_qty is null then
        line_issues := line_issues || format('元件「%s」v%s 成本不完整', cr.name, cv.version_no);
      else
        component_unit_cost := component_snapshot.batch_cost / cv.batch_output_qty;
        if component_qty is not null then line_cost := component_qty * component_unit_cost; end if;
      end if;
      base_qty := component_qty;
      purchase_qty := component_qty;
      unit_cost := component_unit_cost;
      if cv.batch_output_unit = 'g' then gram_weight := component_qty;
      elsif cv.batch_output_unit = 'ml' and cv.output_density_g_per_ml is not null and component_qty is not null then gram_weight := component_qty * cv.output_density_g_per_ml;
      end if;
      details := details || jsonb_build_array(jsonb_build_object(
        'line_id', l.id, 'kind', 'component', 'name', cr.name || ' v' || cv.version_no, 'quantity', l.quantity, 'unit', l.unit,
        'base_qty', base_qty, 'base_unit', cv.batch_output_unit, 'waste_rate', 0, 'purchase_qty', purchase_qty,
        'unit_cost', unit_cost, 'cost', line_cost, 'purchase_price_id', null, 'component_version_id', cv.id
      ));
    end if;
    if line_cost is null then issues := issues || line_issues; else known_cost := known_cost + line_cost; end if;
    if input_weight_g is not null then
      if gram_weight is null then input_weight_g := null; else input_weight_g := input_weight_g + gram_weight; end if;
    end if;
  end loop;

  if not exists (select 1 from app.recipe_lines where version_id = v.id) then issues := issues || '還沒有任何用料'; end if;
  if v.batch_output_qty is null or v.batch_output_unit is null then issues := issues || '批次產量未填'; end if;
  if v.serving_qty is null or v.serving_unit is null then issues := issues || '每份量未填'; end if;
  if coalesce(array_length(issues, 1), 0) = 0 then batch_cost := known_cost; end if;

  if batch_cost is not null and v.batch_output_qty is not null and v.batch_output_unit is not null then
    if r.type = 'dish' then
      serving_cost := batch_cost;
    else
      serving_in_output := app.component_qty_in_output(v.serving_qty, v.serving_unit, v);
      if serving_in_output is null then issues := issues || '每份量無法換算成批次產量單位';
      else serving_cost := batch_cost / v.batch_output_qty * serving_in_output;
      end if;
    end if;
  end if;
  if v.batch_output_unit = 'g' then output_weight_g := v.batch_output_qty;
  elsif v.batch_output_unit = 'ml' and v.output_density_g_per_ml is not null then output_weight_g := v.batch_output_qty * v.output_density_g_per_ml;
  end if;
  if input_weight_g is not null and input_weight_g > 0 and output_weight_g is not null then yield_rate := output_weight_g / input_weight_g; end if;

  if r.type = 'dish' then
    select price into menu_price from app.menu_prices
    where recipe_id = r.id and effective_date <= as_of order by effective_date desc, created_at desc limit 1;
    if menu_price is not null and serving_cost is not null then
      select (value #>> '{}')::numeric into tax_rate from app.app_settings where key = 'sales_tax_rate';
      food_cost_rate := serving_cost / (menu_price / (1 + tax_rate));
    end if;
  end if;

  return jsonb_build_object(
    'is_complete', coalesce(array_length(issues, 1), 0) = 0 and serving_cost is not null,
    'batch_cost', batch_cost, 'cost_per_serving', serving_cost, 'yield_rate', yield_rate,
    'menu_price', menu_price, 'food_cost_rate', food_cost_rate,
    'detail', jsonb_build_object('as_of', as_of, 'issues', to_jsonb(issues), 'lines', details)
  );
end
$$;

-- ───────────────────────── 防止循環引用與歷程刪除 ─────────────────────────

create or replace function app.would_create_component_cycle(p_version_id uuid, p_component_version_id uuid) returns boolean
language sql stable set search_path = app, pg_temp as $$
  with recursive dependencies(id, path) as (
    select p_component_version_id, array[p_component_version_id]
    union all
    select l.component_version_id, d.path || l.component_version_id
    from dependencies d join app.recipe_lines l on l.version_id = d.id
    where l.component_version_id is not null and not l.component_version_id = any(d.path)
  )
  select exists (select 1 from dependencies where id = p_version_id)
$$;

create or replace function app.guard_component_cycle() returns trigger
language plpgsql set search_path = app, pg_temp as $$
begin
  if new.line_kind = 'component' and app.would_create_component_cycle(new.version_id, new.component_version_id) then
    raise exception '元件引用會形成循環，請改用不依賴目前食譜的元件' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger guard_component_cycle before insert or update on app.recipe_lines
  for each row execute function app.guard_component_cycle();

create or replace function app.reject_direct_change() returns trigger
language plpgsql as $$
begin
  -- 草案或食譜刪除時，外鍵的連帶清理會觸發這裡；保留該清理，拒絕任何直接修改。
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception '%', tg_argv[0] using errcode = '42501';
end
$$;

drop trigger if exists status_history_append_only on app.version_status_history;
create trigger status_history_append_only before update or delete on app.version_status_history
  for each row execute function app.reject_direct_change('狀態歷程只能新增，不能修改或刪除');
drop trigger if exists cost_snapshots_append_only on app.cost_snapshots;
create trigger cost_snapshots_append_only before update or delete on app.cost_snapshots
  for each row execute function app.reject_direct_change('成本快照只能新增，不能修改或刪除');

-- ───────────────────────── 試菜資料在定版後完全唯讀 ─────────────────────────

create or replace function app.feedback_editable(f app.tasting_feedback) returns boolean
language sql stable set search_path = app, pg_temp as $$
  select v.status in ('testing', 'pending_approval')
  from app.tasting_items ti join app.recipe_versions v on v.id = ti.version_id
  where ti.id = f.tasting_item_id
$$;

create or replace function app.guard_feedback_editable() returns trigger
language plpgsql set search_path = app, pg_temp as $$
declare st text;
begin
  select v.status into st
  from app.tasting_items ti join app.recipe_versions v on v.id = ti.version_id
  where ti.id = coalesce(new.tasting_item_id, old.tasting_item_id);
  if st not in ('testing', 'pending_approval') then
    raise exception '版本已定版或停用，評分不能新增、修改或刪除' using errcode = '42501';
  end if;
  return coalesce(new, old);
end
$$;

create trigger guard_feedback_editable before insert or update or delete on app.tasting_feedback
  for each row execute function app.guard_feedback_editable();

-- ───────────────────────── 定版時忽略瀏覽器成本資料，改由資料庫重算 ─────────────────────────

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
  snapshot jsonb;
begin
  if uid is null then raise exception '請先登入' using errcode = '28000'; end if;
  perform app.set_context('transition_version');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;
  roles := app.transition_roles(v.status, p_to);
  if roles is null then raise exception '不允許的狀態轉移：% → %', app.status_label(v.status), app.status_label(p_to) using errcode = '42501'; end if;
  if my is null or not (my = any (roles)) then raise exception '權限不足' using errcode = '42501'; end if;
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
    if v.status = 'testing' and (select value from app.app_settings where key = 'require_tasting_before_approval') = 'true'::jsonb
       and not exists (select 1 from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id where ti.version_id = v.id) then
      blockers := blockers || '尚未有試吃評分（系統設定要求送核准前要有試菜紀錄）'::text;
    end if;
  elsif p_to = 'draft' then
    if exists (select 1 from app.tasting_items where version_id = v.id) then blockers := blockers || '已經有試做項目，不能退回草案；請複製為新版本'::text; end if;
    if exists (select 1 from app.recipe_lines where component_version_id = v.id) then blockers := blockers || '已被其他食譜版本引用，不能退回草案'::text; end if;
  elsif p_to = 'locked' then
    blockers := app.version_blockers(v.id, 'lock');
    snapshot := app.server_cost_snapshot(v.id, app.today());
    if coalesce((snapshot ->> 'is_complete')::boolean, false) is not true then
      blockers := blockers || array[format('成本不完整，不能定版：%s', coalesce((snapshot -> 'detail' -> 'issues')::text, '請檢查用料與單價'))];
    end if;
  end if;
  if coalesce(array_length(blockers, 1), 0) > 0 then raise exception '無法變更狀態：%', array_to_string(blockers, '；'); end if;
  if p_to = 'locked' then
    select * into prev from app.recipe_versions where recipe_id = v.recipe_id and status = 'locked' for update;
    if prev.id is not null then
      update app.recipe_versions set status = 'retired', retired_at = now(), retired_by = null,
        retire_reason = '被 v' || v.version_no || ' 取代', superseded_by_version_id = v.id where id = prev.id;
      insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
      values (prev.id, 'locked', 'retired', null, '被 v' || v.version_no || ' 取代');
    end if;
    insert into app.cost_snapshots (version_id, reason, price_as_of, batch_cost, cost_per_serving, yield_rate, menu_price, food_cost_rate, is_complete, detail)
    values (v.id, 'lock', app.today(), nullif(snapshot ->> 'batch_cost', '')::numeric,
      nullif(snapshot ->> 'cost_per_serving', '')::numeric, nullif(snapshot ->> 'yield_rate', '')::numeric,
      nullif(snapshot ->> 'menu_price', '')::numeric, nullif(snapshot ->> 'food_cost_rate', '')::numeric,
      true, coalesce(snapshot -> 'detail', '{}'::jsonb));
  end if;
  update app.recipe_versions set status = p_to,
    submitted_by = case when p_to = 'pending_approval' then uid else submitted_by end,
    submitted_at = case when p_to = 'pending_approval' then now() else submitted_at end,
    approved_by = case when p_to = 'locked' then uid else approved_by end,
    approved_at = case when p_to = 'locked' then now() else approved_at end,
    retired_by = case when p_to = 'retired' then uid else retired_by end,
    retired_at = case when p_to = 'retired' then now() else retired_at end,
    retire_reason = case when p_to = 'retired' then c else retire_reason end
  where id = v.id;
  insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment) values (v.id, v.status, p_to, uid, c);
  return jsonb_build_object('id', v.id, 'status', p_to);
end
$$;

-- 新 migration 的 public 函式預設不應開給 anon。
revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;
