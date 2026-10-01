-- 試菜與標準食譜系統：全系統重讀後的校正（2026-10-02）
-- 1. 定版／送核准的成本快照：元件成本改成和前端相同的規則（依今天單價即時重算），不再取元件定版當時的快照
-- 2. 送核准時在資料庫檢查成本完整（CLAUDE.md §4 狀態表）
-- 3. 評分只收「試菜中／待核准」：測試人員的待辦與首頁計數不再列出已定版的項目
-- 4. 菜品清單的「最新版本」略過已停用的版本
-- 5. 已有報價的包裝規格不能改包裝數量或單位（等於改寫所有舊報價）
-- 6. 基準版匯入：保留用料與步驟順序、菜品產量、檢查單位、只引用已凍結的元件版本、送試菜失敗改為警告
-- 7. 記錄已執行的 migration 版本，前端可以提醒「資料庫還沒更新」
-- 8. 收回 0009–0011 漏掉的 anon 權限（Supabase 預設會把新函式開放給 anon）

-- ───────────────────────── migration 版本紀錄 ─────────────────────────

create table if not exists app.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
alter table app.schema_migrations enable row level security;
drop trigger if exists audit on app.schema_migrations;
create trigger audit after insert or update or delete on app.schema_migrations
  for each row execute function app.audit();

insert into app.schema_migrations (version)
select unnest(array[
  '20260916000001', '20260916000002', '20260916000003', '20260916000004', '20260916000005', '20260916000006',
  '20260922000007', '20260922000008', '20260923000009', '20260923000010', '20260923000011'
])
on conflict (version) do nothing;

-- 每個 migration 結尾都呼叫這個函式：重跑權限設定（0006 的權限區塊）並記錄版本。
-- 只有執行 migration 的資料庫擁有者會呼叫；app schema 對前端完全不可見。
create or replace function app.finish_migration(p_version text) returns void
language plpgsql as $$
begin
  revoke all on all tables in schema app from public;
  revoke execute on all functions in schema app from public;
  revoke execute on all functions in schema public from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema app from anon';
    execute 'revoke execute on all functions in schema app from anon';
    execute 'revoke execute on all functions in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema app from authenticated';
    execute 'revoke execute on all functions in schema app from authenticated';
    execute 'grant execute on all functions in schema public to authenticated';
  end if;
  insert into app.schema_migrations (version) values (p_version) on conflict (version) do nothing;
end
$$;

-- 前端比對自己需要的資料庫版本；登入後才回傳
create or replace function public.schema_version() returns text
language sql stable security definer set search_path = app, pg_temp as $$
  select max(version) from app.schema_migrations where auth.uid() is not null
$$;

-- 去除重複訊息，保留第一次出現的順序
create or replace function app.dedupe_text(p text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(x order by first_pos), '{}'::text[])
  from (select x, min(pos) as first_pos from unnest(p) with ordinality as t(x, pos) group by x) d
$$;

-- ───────────────────────── 成本快照（和 src/domain/costing.ts 同一組規則） ─────────────────────────

create or replace function app.server_cost_snapshot(p_version_id uuid, p_as_of date default null) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
  r app.recipes;
  l app.recipe_lines;
  i app.ingredients;
  cv app.recipe_versions;
  cr app.recipes;
  sub jsonb;
  as_of date := coalesce(p_as_of, app.today());
  line_count int := 0;
  line_name text;
  pack_qty numeric;
  pack_unit text;
  price_id uuid;
  price numeric;
  pack_base_qty numeric;
  base_qty numeric;
  purchase_qty numeric;
  unit_cost numeric;
  line_cost numeric;
  waste_rate numeric;
  gram_weight numeric;
  known_cost numeric := 0;
  complete boolean := true;
  input_weight_g numeric := 0;
  output_weight_g numeric;
  batch_cost numeric;
  serving_cost numeric;
  serving_in_output numeric;
  yield_rate numeric;
  menu_price numeric;
  food_cost_rate numeric;
  tax_rate numeric;
  issues text[] := '{}';
  details jsonb := '[]'::jsonb;
begin
  select * into v from app.recipe_versions where id = p_version_id;
  if v.id is null then raise exception '找不到此版本'; end if;
  select * into r from app.recipes where id = v.recipe_id;

  for l in select * from app.recipe_lines where version_id = v.id order by sort_order, created_at loop
    line_count := line_count + 1;
    base_qty := null; purchase_qty := null; unit_cost := null; line_cost := null; gram_weight := null;
    waste_rate := 0; price_id := null; price := null; pack_qty := null; pack_unit := null;

    if l.line_kind = 'ingredient' then
      select * into i from app.ingredients where id = l.ingredient_id;
      line_name := i.name;
      waste_rate := coalesce(l.waste_rate_override, i.default_waste_rate);
      if waste_rate < 0 or waste_rate >= 1 then
        issues := issues || format('「%s」損耗率必須介於 0%% 與 100%% 之間', i.name);
      else
        -- 單位成本 = 預設規格的有效單價 ÷ 規格換算成基本單位的數量
        select s.pack_qty, s.pack_unit, pp.id, pp.price into pack_qty, pack_unit, price_id, price
        from app.packaging_specs s
        left join lateral (
          select x.id, x.price from app.purchase_prices x
          where x.packaging_spec_id = s.id and not x.is_void and x.effective_date <= as_of
          order by x.effective_date desc, x.created_at desc
          limit 1
        ) pp on true
        where s.ingredient_id = i.id and s.is_default;
        if not found then
          issues := issues || format('「%s」沒有預設包裝規格', i.name);
        elsif price_id is null then
          issues := issues || format('「%s」沒有有效單價', i.name);
        else
          pack_base_qty := app.ingredient_qty_in_base(pack_qty, pack_unit, i);
          if pack_base_qty is null then
            issues := issues || format('「%s」的包裝規格無法換算成基本單位', i.name);
          else
            unit_cost := price / pack_base_qty;
          end if;
        end if;
        -- 採購量 = 淨重 ÷（1 − 損耗率）；行成本 = 採購量 × 單位成本
        if l.quantity is null then
          issues := issues || format('「%s」用量待填', i.name);
        else
          base_qty := app.ingredient_qty_in_base(l.quantity, l.unit, i);
          if base_qty is null then
            issues := issues || format('「%s」的用量單位「%s」無法換算', i.name, l.unit);
          else
            purchase_qty := base_qty / (1 - waste_rate);
            if unit_cost is not null then line_cost := purchase_qty * unit_cost; end if;
            if i.base_dimension = 'mass' then gram_weight := base_qty;
            elsif i.base_dimension = 'volume' and i.density_g_per_ml is not null then gram_weight := base_qty * i.density_g_per_ml;
            end if;
          end if;
        end if;
      end if;
    else
      -- 引用元件：用被引用版本「今天」的每單位產出成本（和前端即時計算相同）
      select * into cv from app.recipe_versions where id = l.component_version_id;
      select * into cr from app.recipes where id = cv.recipe_id;
      line_name := cr.name || ' v' || cv.version_no;
      sub := app.server_cost_snapshot(cv.id, as_of);
      if (sub ->> 'batch_cost') is null or cv.batch_output_qty is null then
        issues := issues || format('元件「%s」v%s 成本不完整', cr.name, cv.version_no);
      else
        unit_cost := (sub ->> 'batch_cost')::numeric / cv.batch_output_qty;
      end if;
      if l.quantity is null then
        issues := issues || format('「%s」用量待填', cr.name);
      else
        base_qty := app.component_qty_in_output(l.quantity, l.unit, cv);
        if base_qty is null then
          issues := issues || format('元件「%s」v%s 的用量單位「%s」無法換算', cr.name, cv.version_no, l.unit);
        else
          purchase_qty := base_qty;
          if unit_cost is not null then line_cost := base_qty * unit_cost; end if;
          if cv.batch_output_unit = 'g' then gram_weight := base_qty;
          elsif cv.output_density_g_per_ml is not null then gram_weight := base_qty * cv.output_density_g_per_ml;
          end if;
        end if;
      end if;
    end if;

    if line_cost is null then complete := false; else known_cost := known_cost + line_cost; end if;
    if gram_weight is null then input_weight_g := null;
    elsif input_weight_g is not null then input_weight_g := input_weight_g + gram_weight;
    end if;
    details := details || jsonb_build_array(jsonb_build_object(
      'line_id', l.id, 'kind', l.line_kind, 'name', line_name, 'quantity', l.quantity, 'unit', l.unit,
      'base_qty', base_qty,
      'base_unit', case when l.line_kind = 'component' then cv.batch_output_unit
                        else case i.base_dimension when 'mass' then 'g' when 'volume' then 'ml' else 'pc' end end,
      'waste_rate', case when l.line_kind = 'component' then 0 else waste_rate end,
      'purchase_qty', purchase_qty, 'unit_cost', unit_cost, 'cost', line_cost,
      'purchase_price_id', price_id,
      'component_version_id', case when l.line_kind = 'component' then cv.id end
    ));
  end loop;

  if line_count = 0 then
    complete := false;
    input_weight_g := null;
    issues := issues || '還沒有任何用料'::text;
  end if;

  if v.batch_output_qty is null or v.batch_output_unit is null then
    complete := false;
    issues := issues || (case when r.type = 'dish' then '每份量未填' else '批次產量未填' end)::text;
  else
    output_weight_g := case
      when v.batch_output_unit = 'g' then v.batch_output_qty
      when v.output_density_g_per_ml is not null then v.batch_output_qty * v.output_density_g_per_ml
    end;
  end if;
  if r.type = 'component' and (v.serving_qty is null or v.serving_unit is null) then
    complete := false;
    issues := issues || '每份量未填'::text;
  end if;

  if complete then
    batch_cost := known_cost;
    if r.type = 'dish' then
      serving_cost := batch_cost;
    else
      serving_in_output := app.component_qty_in_output(v.serving_qty, v.serving_unit, v);
      if serving_in_output is null then
        issues := issues || '每份量無法換算成批次產量的單位（g 與 ml 互換需要成品密度）'::text;
      else
        serving_cost := batch_cost / v.batch_output_qty * serving_in_output;
      end if;
    end if;
  end if;

  if input_weight_g is not null and input_weight_g > 0 and output_weight_g is not null then
    yield_rate := output_weight_g / input_weight_g;
  end if;

  if r.type = 'dish' and serving_cost is not null then
    select mp.price into menu_price from app.menu_prices mp
    where mp.recipe_id = r.id and mp.effective_date <= as_of
    order by mp.effective_date desc, mp.created_at desc
    limit 1;
    if menu_price is not null then
      select (value #>> '{}')::numeric into tax_rate from app.app_settings where key = 'sales_tax_rate';
      food_cost_rate := serving_cost / (menu_price / (1 + tax_rate));
    end if;
  end if;

  return jsonb_build_object(
    'is_complete', complete and serving_cost is not null,
    'batch_cost', batch_cost, 'cost_per_serving', serving_cost, 'yield_rate', yield_rate,
    'menu_price', menu_price, 'food_cost_rate', food_cost_rate,
    'detail', jsonb_build_object('as_of', as_of, 'issues', to_jsonb(app.dedupe_text(issues)), 'lines', details)
  );
end
$$;

-- ───────────────────────── 狀態轉移：送核准也要成本完整 ─────────────────────────

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
  -- p_snapshot 只為了相容舊版前端而保留，資料庫一律自行重算，不採用瀏覽器送來的數字
  if uid is null then raise exception '請先登入' using errcode = '28000'; end if;
  perform app.set_context('transition_version');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;

  roles := app.transition_roles(v.status, p_to);
  if roles is null then
    raise exception '不允許的狀態轉移：% → %', app.status_label(v.status), app.status_label(p_to) using errcode = '42501';
  end if;
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
    if v.status = 'testing'
       and (select value from app.app_settings where key = 'require_tasting_before_approval') = 'true'::jsonb
       and not exists (
         select 1 from app.tasting_feedback f join app.tasting_items ti on ti.id = f.tasting_item_id where ti.version_id = v.id
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
  end if;

  -- 送核准與定版都要成本完整；先處理上面的基本條件，再列出成本缺什麼
  if p_to in ('pending_approval', 'locked') and coalesce(array_length(blockers, 1), 0) = 0 then
    snapshot := app.server_cost_snapshot(v.id, app.today());
    if coalesce((snapshot ->> 'is_complete')::boolean, false) is not true then
      blockers := blockers || '成本不完整'::text
        || coalesce(array(select jsonb_array_elements_text(snapshot -> 'detail' -> 'issues')), '{}'::text[]);
    end if;
  end if;

  blockers := app.dedupe_text(blockers);
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
      nullif(snapshot ->> 'batch_cost', '')::numeric,
      nullif(snapshot ->> 'cost_per_serving', '')::numeric,
      nullif(snapshot ->> 'yield_rate', '')::numeric,
      nullif(snapshot ->> 'menu_price', '')::numeric,
      nullif(snapshot ->> 'food_cost_rate', '')::numeric,
      true,
      coalesce(snapshot -> 'detail', '{}'::jsonb)
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

-- ───────────────────────── 評分只收試菜中／待核准 ─────────────────────────

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
      'can_submit', v.status in ('testing', 'pending_approval')
    ) order by s.tasted_on desc, ti.sort_order)
    from app.tasting_items ti
    join app.tasting_sessions s on s.id = ti.session_id
    join app.recipe_versions v on v.id = ti.version_id
    join app.recipes r on r.id = v.recipe_id
    where uid = any (ti.assigned_tester_ids)
      and (
        v.status in ('testing', 'pending_approval')
        -- 已定版的項目只留下自己評過的（查看用），沒評過的不再顯示成「待評分」
        or (v.status = 'locked' and exists (
          select 1 from app.tasting_feedback f where f.tasting_item_id = ti.id and f.taster_id = uid
        ))
      )
  ), '[]'::jsonb);
end
$$;

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
      where uid = any (ti.assigned_tester_ids) and v.status in ('testing', 'pending_approval')
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
    ), '[]'::jsonb)
  );
end
$$;

-- ───────────────────────── 菜品清單：最新版本略過已停用 ─────────────────────────

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
      -- 最新且還在進行的版本；放棄的版本（停用）不算，全部都停用時才回傳最新的那一個
      'latest', (
        select jsonb_build_object('id', v.id, 'version_no', v.version_no, 'title', v.title, 'status', v.status,
                                  'updated_at', v.updated_at)
        from app.recipe_versions v where v.recipe_id = r.id
        order by (v.status = 'retired'), v.version_no desc
        limit 1
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

-- ───────────────────────── 包裝規格：已有報價不能改數量或單位 ─────────────────────────

create or replace function public.upsert_packaging_spec(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_ingredient uuid;
  v_default boolean := coalesce((p ->> 'is_default')::boolean, false);
  cur app.packaging_specs;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_packaging_spec');
  if v_id is null then
    v_ingredient := (p ->> 'ingredient_id')::uuid;
  else
    select * into cur from app.packaging_specs where id = v_id for update;
    if cur.id is null then raise exception '找不到此包裝規格'; end if;
    v_ingredient := cur.ingredient_id;
  end if;
  if not exists (select 1 from app.ingredients where id = v_ingredient) then raise exception '找不到此原物料'; end if;
  if btrim(coalesce(p ->> 'spec_name', '')) = '' then raise exception '請填寫規格名稱，例如「20 kg/箱」'; end if;
  if coalesce((p ->> 'pack_qty')::numeric, 0) <= 0 then raise exception '包裝數量必須大於 0'; end if;
  if not app.is_valid_ingredient_unit(v_ingredient, p ->> 'pack_unit') then
    raise exception '單位「%」不適用於此原物料', p ->> 'pack_unit';
  end if;
  -- 報價是「這個規格的價格」；改了包裝數量或單位，等於把所有舊報價的單位成本一起改掉
  if cur.id is not null
     and (cur.pack_qty <> (p ->> 'pack_qty')::numeric or cur.pack_unit <> (p ->> 'pack_unit'))
     and exists (select 1 from app.purchase_prices where packaging_spec_id = cur.id and not is_void) then
    raise exception '這個規格已經有報價，不能修改包裝數量或單位；請新增一個規格並設為預設';
  end if;

  -- 原物料還沒有預設規格時，第一個規格自動成為預設
  if not exists (select 1 from app.packaging_specs where ingredient_id = v_ingredient and is_default and id is distinct from v_id) then
    v_default := true;
  end if;
  if v_default then
    update app.packaging_specs set is_default = false
    where ingredient_id = v_ingredient and is_default and id is distinct from v_id;
  end if;

  if v_id is null then
    insert into app.packaging_specs (ingredient_id, supplier_id, spec_name, pack_qty, pack_unit, is_default, is_active, note)
    values (v_ingredient, nullif(p ->> 'supplier_id', '')::uuid, btrim(p ->> 'spec_name'), (p ->> 'pack_qty')::numeric,
            p ->> 'pack_unit', v_default, coalesce((p ->> 'is_active')::boolean, true), coalesce(p ->> 'note', ''))
    returning id into v_id;
  else
    update app.packaging_specs set
      supplier_id = nullif(p ->> 'supplier_id', '')::uuid,
      spec_name = btrim(p ->> 'spec_name'),
      pack_qty = (p ->> 'pack_qty')::numeric,
      pack_unit = p ->> 'pack_unit',
      is_default = v_default,
      is_active = coalesce((p ->> 'is_active')::boolean, true),
      note = coalesce(p ->> 'note', '')
    where id = v_id;
  end if;
  return v_id;
end
$$;

-- ───────────────────────── 基準版匯入 ─────────────────────────

create or replace function public.import_baseline(p_file jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  item jsonb;
  recipe jsonb;
  version_data jsonb;
  line jsonb;
  line_no bigint;
  step jsonb;
  step_no bigint;
  ing app.ingredients;
  v_component_version uuid;
  created_recipe jsonb;
  v_version_id uuid;
  v_qty numeric;
  v_unit text;
  v_heat text;
  v_serving numeric;
  v_serving_unit text;
  recipe_type text;
  recipe_name text;
  created_ingredients int := 0;
  skipped_ingredients int := 0;
  created_recipes int := 0;
  skipped_recipes int := 0;
  warnings text[] := '{}';
begin
  perform app.require_role('founder');
  perform app.set_context('import_baseline');
  if jsonb_typeof(p_file -> 'ingredients') is distinct from 'array' or jsonb_typeof(p_file -> 'recipes') is distinct from 'array' then
    raise exception '檔案格式不正確：必須包含 ingredients 與 recipes 陣列';
  end if;

  for item in select value from jsonb_array_elements(p_file -> 'ingredients') loop
    if btrim(coalesce(item ->> 'name', '')) = '' then raise exception '原物料缺少名稱'; end if;
    if coalesce(item ->> 'base_dimension', '') not in ('mass', 'volume', 'count') then
      raise exception '原物料「%」的基本單位必須是 mass、volume 或 count', item ->> 'name';
    end if;
    insert into app.ingredients (name, category, base_dimension, density_g_per_ml, note)
    values (
      btrim(item ->> 'name'), coalesce(nullif(item ->> 'category', ''), 'other'), item ->> 'base_dimension',
      nullif(item ->> 'density_g_per_ml', '')::numeric, coalesce(item ->> 'note', '')
    )
    on conflict (name) do nothing;
    if found then created_ingredients := created_ingredients + 1; else skipped_ingredients := skipped_ingredients + 1; end if;
  end loop;

  -- 元件先建（菜品要引用），兩類各自保留檔案中的順序
  for recipe in
    select x.value from jsonb_array_elements(p_file -> 'recipes') with ordinality x(value, n)
    order by (x.value ->> 'type' = 'dish'), x.n
  loop
    recipe_type := recipe ->> 'type';
    recipe_name := btrim(coalesce(recipe ->> 'name', ''));
    if coalesce(recipe_type, '') not in ('dish', 'component') or recipe_name = '' then
      raise exception '食譜缺少有效類型或名稱';
    end if;
    if exists (select 1 from app.recipes where type = recipe_type and name = recipe_name) then
      skipped_recipes := skipped_recipes + 1;
      continue;
    end if;

    created_recipe := public.create_recipe(jsonb_build_object(
      'type', recipe_type, 'name', recipe_name, 'component_kind', recipe ->> 'component_kind',
      'menu_category', coalesce(recipe ->> 'menu_category', ''), 'description', coalesce(recipe ->> 'description', '')
    ));
    perform app.set_context('import_baseline');
    v_version_id := (created_recipe ->> 'version_id')::uuid;
    version_data := coalesce(recipe -> 'version', '{}'::jsonb);
    v_serving := nullif(version_data ->> 'serving_qty', '')::numeric;
    v_serving_unit := coalesce(nullif(version_data ->> 'serving_unit', ''), 'g');

    -- 和 save_version_draft 相同：菜品的批次產量就是每份量
    update app.recipe_versions set
      title = coalesce(version_data ->> 'title', ''),
      change_note = coalesce(version_data ->> 'change_note', ''),
      serving_qty = v_serving,
      serving_unit = v_serving_unit,
      batch_output_qty = case when recipe_type = 'dish' then v_serving else nullif(version_data ->> 'batch_output_qty', '')::numeric end,
      batch_output_unit = case when recipe_type = 'dish' then v_serving_unit
                               else coalesce(nullif(version_data ->> 'batch_output_unit', ''), 'g') end,
      storage_method = coalesce(version_data ->> 'storage_method', ''),
      shelf_life_hours = nullif(version_data ->> 'shelf_life_hours', '')::int,
      notes = coalesce(version_data ->> 'notes', '')
    where id = v_version_id;

    for line, line_no in
      select x.value, x.n from jsonb_array_elements(coalesce(version_data -> 'lines', '[]'::jsonb)) with ordinality x(value, n)
    loop
      v_qty := nullif(line ->> 'quantity', '')::numeric;
      if v_qty is not null and v_qty <= 0 then
        raise exception '「%」第 % 行：用量必須大於 0', recipe_name, line_no;
      end if;
      if nullif(line ->> 'component', '') is not null then
        -- 只能引用已凍結的元件版本（CLAUDE.md §4 規則 7）；有定版用定版，否則用最新的試菜中／待核准版本
        select v.id into v_component_version
        from app.recipes r join app.recipe_versions v on v.recipe_id = r.id
        where r.type = 'component' and r.name = line ->> 'component'
          and v.status in ('testing', 'pending_approval', 'locked')
        order by (v.status = 'locked') desc, v.version_no desc
        limit 1;
        if v_component_version is null then
          raise exception '「%」引用的元件「%」不存在或尚未建立可引用的版本（元件必須先送試菜）', recipe_name, line ->> 'component';
        end if;
        v_unit := coalesce(nullif(line ->> 'unit', ''), 'g');
        if v_unit not in ('g', 'kg', '台斤', '兩', 'ml', 'L', '份') then
          raise exception '「%」第 % 行：元件用量單位必須是重量、容量或「份」', recipe_name, line_no;
        end if;
        insert into app.recipe_lines (version_id, sort_order, line_kind, component_version_id, quantity, unit, prep_note, group_label)
        values (v_version_id, line_no, 'component', v_component_version, v_qty, v_unit,
                coalesce(line ->> 'prep_note', ''), btrim(coalesce(line ->> 'group_label', '')));
      else
        select * into ing from app.ingredients where name = line ->> 'ingredient';
        if ing.id is null then
          raise exception '「%」使用的原物料「%」不存在', recipe_name, coalesce(line ->> 'ingredient', '');
        end if;
        v_unit := coalesce(nullif(line ->> 'unit', ''),
                           case ing.base_dimension when 'mass' then 'g' when 'volume' then 'ml' else 'pc' end);
        if not app.is_valid_ingredient_unit(ing.id, v_unit) then
          raise exception '「%」第 % 行：單位「%」不適用於「%」', recipe_name, line_no, v_unit, ing.name;
        end if;
        insert into app.recipe_lines (version_id, sort_order, line_kind, ingredient_id, quantity, unit, prep_note, group_label)
        values (v_version_id, line_no, 'ingredient', ing.id, v_qty, v_unit,
                coalesce(line ->> 'prep_note', ''), btrim(coalesce(line ->> 'group_label', '')));
      end if;
    end loop;

    for step, step_no in
      select x.value, x.n from jsonb_array_elements(coalesce(version_data -> 'steps', '[]'::jsonb)) with ordinality x(value, n)
    loop
      v_heat := nullif(step ->> 'heat_level', '');
      if v_heat is not null and v_heat not in ('high', 'medium', 'low', 'simmer') then
        raise exception '「%」第 % 個步驟：火力設定錯誤', recipe_name, step_no;
      end if;
      insert into app.recipe_steps (version_id, step_no, instruction, duration_minutes, temperature_c, heat_level, is_critical, critical_note)
      values (v_version_id, step_no, coalesce(step ->> 'instruction', ''),
              nullif(step ->> 'duration_minutes', '')::numeric, nullif(step ->> 'temperature_c', '')::numeric,
              v_heat, coalesce((step ->> 'is_critical')::boolean, false), coalesce(step ->> 'critical_note', ''));
    end loop;

    if coalesce((recipe ->> 'to_testing')::boolean, false) then
      -- 送試菜失敗（例如用量待填）時保留草案並回報，不讓整批匯入失敗
      begin
        perform public.transition_version(v_version_id, 'testing', '由基準版菜單匯入');
      exception when others then
        warnings := warnings || format('「%s」無法送試菜，保留為草案：%s', recipe_name, sqlerrm);
      end;
      perform app.set_context('import_baseline');
    end if;
    created_recipes := created_recipes + 1;
  end loop;

  return jsonb_build_object(
    'created_ingredients', created_ingredients, 'skipped_ingredients', skipped_ingredients,
    'created_recipes', created_recipes, 'skipped_recipes', skipped_recipes,
    'warnings', to_jsonb(warnings)
  );
end
$$;

select app.finish_migration('20261002000012');
