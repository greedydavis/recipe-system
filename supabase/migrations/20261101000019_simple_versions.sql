-- 流程簡化（使用者 2026-11-01 決定）：只輸入最後定案的版本，拿掉試菜、評分與核准關卡。
-- 版本狀態只剩：草案 → 定版 →（被取代或手動）停用。
--   - 定版只有創辦人可以按；用量、產量要填齊，成本不要求完整（單價之後再補）
--   - 草案可以引用草案；定版時引用的元件必須已定版
--   - 試菜場次、試做項目、評分的資料留在資料庫（備份匯出也有），只是不再提供操作的 RPC
--   - 測試人員角色停用：現有帳號改回待審核

select app.set_context('simple_versions');

-- ───────────────────────── 現有資料 ─────────────────────────

-- 試菜中、待核准的版本回到草案，引用關係不變
insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
select id, status, 'draft', null, '流程簡化：不再有試菜與核准，回到草案'
from app.recipe_versions where status in ('testing', 'pending_approval');

update app.recipe_versions set status = 'testing' where status = 'pending_approval';
update app.recipe_versions set status = 'draft' where status = 'testing';

update app.profiles set role = 'pending' where role = 'tester';

-- ───────────────────────── 版本列的保護 ─────────────────────────

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
       old.prep_minutes, old.cook_minutes, old.storage_method, old.shelf_life_hours,
       old.notes, old.created_by, old.created_at,
       old.batch_output_qty, old.batch_output_unit, old.serving_qty, old.serving_unit, old.output_density_g_per_ml
     ) is distinct from (
       new.recipe_id, new.version_no, new.title, new.change_note,
       new.prep_minutes, new.cook_minutes, new.storage_method, new.shelf_life_hours,
       new.notes, new.created_by, new.created_at,
       new.batch_output_qty, new.batch_output_unit, new.serving_qty, new.serving_unit, new.output_density_g_per_ml
     ) then
    perform app.frozen_error(old.status);
  end if;

  if new.status is distinct from old.status and (old.status, new.status) not in (
       ('draft', 'locked'), ('locked', 'retired')
     ) then
    raise exception '不允許的狀態轉移：% → %', app.status_label(old.status), app.status_label(new.status)
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ───────────────────────── 狀態轉移 ─────────────────────────

-- 允許此狀態轉移的角色；不允許的轉移回傳 null（必須和 src/domain/status.ts 一致）
create or replace function app.transition_roles(p_from text, p_to text) returns text[]
language sql immutable as $$
  select case when (p_from, p_to) in (('draft', 'locked'), ('locked', 'retired')) then array['founder'] end
$$;

drop function app.version_blockers(uuid, text);

-- 定版前要填齊的內容。成本不在這裡：單價可以定版之後再補
create or replace function app.lock_blockers(p_version_id uuid) returns text[]
language plpgsql stable as $$
declare
  v app.recipe_versions;
  r app.recipes;
  msgs text[] := '{}';
  rec record;
begin
  select * into v from app.recipe_versions where id = p_version_id;
  select * into r from app.recipes where id = v.recipe_id;
  if not exists (select 1 from app.recipe_lines where version_id = v.id) then
    msgs := msgs || '至少要有 1 行用料'::text;
  end if;

  if r.type = 'dish' then
    if v.serving_qty is null then msgs := msgs || '請填寫每份克重'::text; end if;
  else
    if v.batch_output_qty is null then msgs := msgs || '請填寫批次產量'::text; end if;
    if v.serving_qty is null then msgs := msgs || '請填寫每份量'::text; end if;
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
    where l.version_id = v.id and cv.status <> 'locked'
    order by l.sort_order
  loop
    msgs := msgs || format('引用的元件「%s」v%s 為「%s」，要先定版元件', rec.name, rec.version_no, app.status_label(rec.status));
  end loop;

  if app.component_depth(v.id) > 5 then msgs := msgs || '元件巢狀超過 5 層'::text; end if;
  return msgs;
end
$$;

drop function public.transition_version(uuid, text, text, jsonb);

create function public.transition_version(p_version_id uuid, p_to text, p_comment text default '') returns jsonb
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
  if roles is null then
    raise exception '不允許的狀態轉移：% → %', app.status_label(v.status), app.status_label(p_to) using errcode = '42501';
  end if;
  if my is null or not (my = any (roles)) then raise exception '權限不足' using errcode = '42501'; end if;
  if p_to = 'retired' and c = '' then raise exception '請填寫停用原因'; end if;

  if p_to = 'locked' then
    blockers := app.dedupe_text(app.lock_blockers(v.id));
    if coalesce(array_length(blockers, 1), 0) > 0 then
      raise exception '無法定版：%', array_to_string(blockers, '；');
    end if;

    select * into prev from app.recipe_versions where recipe_id = v.recipe_id and status = 'locked' for update;
    if prev.id is not null then
      update app.recipe_versions set
        status = 'retired', retired_at = now(), retired_by = null,
        retire_reason = '被 v' || v.version_no || ' 取代', superseded_by_version_id = v.id
      where id = prev.id;
      insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
      values (prev.id, 'locked', 'retired', null, '被 v' || v.version_no || ' 取代');
    end if;

    -- 快照一律由資料庫重算；單價還沒補齊時 is_complete 為 false，金額欄位留空
    snapshot := app.server_cost_snapshot(v.id, app.today());
    insert into app.cost_snapshots (
      version_id, reason, price_as_of, batch_cost, cost_per_serving, yield_rate, menu_price, food_cost_rate, is_complete, detail
    ) values (
      v.id, 'lock', app.today(),
      nullif(snapshot ->> 'batch_cost', '')::numeric,
      nullif(snapshot ->> 'cost_per_serving', '')::numeric,
      nullif(snapshot ->> 'yield_rate', '')::numeric,
      nullif(snapshot ->> 'menu_price', '')::numeric,
      nullif(snapshot ->> 'food_cost_rate', '')::numeric,
      coalesce((snapshot ->> 'is_complete')::boolean, false),
      coalesce(snapshot -> 'detail', '{}'::jsonb)
    );
  end if;

  update app.recipe_versions set
    status = p_to,
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

-- 草案現在可以被引用，刪除前要擋下來並說明是誰在用
create or replace function public.delete_draft(p_version_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v app.recipe_versions;
  used text;
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('delete_draft');
  select * into v from app.recipe_versions where id = p_version_id for update;
  if v.id is null then raise exception '找不到此版本'; end if;
  if v.status <> 'draft' then raise exception '只有草案可以刪除'; end if;
  if (select count(*) from app.recipe_versions where recipe_id = v.recipe_id) <= 1 then
    raise exception '食譜至少要保留一個版本；不需要的話可以封存食譜';
  end if;
  select string_agg(label, '、') into used from (
    select distinct r.name || ' v' || u.version_no as label
    from app.recipe_lines l
    join app.recipe_versions u on u.id = l.version_id
    join app.recipes r on r.id = u.recipe_id
    where l.component_version_id = v.id
    order by 1
    limit 5
  ) x;
  if used is not null then raise exception '這個草案被其他食譜引用（%），不能刪除', used; end if;
  -- 舊的試菜資料要保留，它們參照這個版本
  if exists (select 1 from app.tasting_items where version_id = v.id) then
    raise exception '這個版本有舊的試菜紀錄，不能刪除；不需要的話可以封存食譜';
  end if;
  delete from app.recipe_versions where id = v.id;
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
      -- 既有且未變更的引用可以保留（例如複製後被取代的舊版元件），新引用不能是已停用的版本
      if cv.status = 'retired'
         and not exists (select 1 from app.recipe_lines where id = row_id and component_version_id = cv.id) then
        raise exception '第 % 行：「%」v% 為「%」，請引用草案或已定版的元件版本',
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

-- ───────────────────────── 匯入 ─────────────────────────

create or replace function app.import_has_new_content(p_version_id uuid, p_version jsonb) returns boolean
language sql stable set search_path = app, pg_temp as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(p_version -> 'lines', '[]'::jsonb)) l
    where case
      when nullif(l ->> 'component', '') is not null then
        -- 還引用不到的元件不算（匯入時也會略過），否則每次重新匯入都會多一個版本
        exists (
          select 1 from app.recipes r join app.recipe_versions v on v.recipe_id = r.id
          where r.type = 'component' and r.name = l ->> 'component' and v.status <> 'retired'
        )
        and not exists (
          select 1
          from app.recipe_lines rl
          join app.recipe_versions cv on cv.id = rl.component_version_id
          join app.recipes cr on cr.id = cv.recipe_id
          where rl.version_id = p_version_id and cr.name = l ->> 'component'
            and (
              nullif(l ->> 'quantity', '') is null
              or (rl.quantity = (l ->> 'quantity')::numeric and rl.unit = coalesce(nullif(l ->> 'unit', ''), 'g'))
            )
        )
      else
        nullif(l ->> 'quantity', '') is not null
        and not exists (
          select 1
          from app.recipe_lines rl join app.ingredients i on i.id = rl.ingredient_id
          where rl.version_id = p_version_id and i.name = l ->> 'ingredient'
            and rl.quantity = (l ->> 'quantity')::numeric
            and rl.unit = coalesce(nullif(l ->> 'unit', ''), rl.unit)
        )
    end
  )
  or exists (
    select 1
    from jsonb_array_elements(coalesce(p_version -> 'steps', '[]'::jsonb)) s
    where btrim(coalesce(s ->> 'instruction', '')) <> ''
      and not exists (
        select 1 from app.recipe_steps rs where rs.version_id = p_version_id and rs.instruction = s ->> 'instruction'
      )
  );
$$;

create or replace function app.import_fill_version(p_version_id uuid, p_type text, p_name text, p_version jsonb) returns text[]
language plpgsql set search_path = app, pg_temp as $$
declare
  line jsonb;
  line_no bigint;
  step jsonb;
  step_no bigint;
  ing app.ingredients;
  v_component_version uuid;
  v_qty numeric;
  v_unit text;
  v_heat text;
  v_serving numeric := nullif(p_version ->> 'serving_qty', '')::numeric;
  v_serving_unit text := nullif(p_version ->> 'serving_unit', '');
  warnings text[] := '{}';
begin
  -- 檔案沒有填的產量、保存方式，保留版本上原有的值（更新時是上一版量到的結果）
  -- 和 save_version_draft 相同：菜品的批次產量就是每份量
  update app.recipe_versions set
    title = coalesce(nullif(p_version ->> 'title', ''), title),
    change_note = coalesce(nullif(p_version ->> 'change_note', ''), change_note),
    serving_qty = coalesce(v_serving, serving_qty),
    serving_unit = coalesce(v_serving_unit, serving_unit, 'g'),
    batch_output_qty = case when p_type = 'dish' then coalesce(v_serving, serving_qty)
                            else coalesce(nullif(p_version ->> 'batch_output_qty', '')::numeric, batch_output_qty) end,
    batch_output_unit = case when p_type = 'dish' then coalesce(v_serving_unit, serving_unit, 'g')
                             else coalesce(nullif(p_version ->> 'batch_output_unit', ''), batch_output_unit, 'g') end,
    storage_method = coalesce(nullif(p_version ->> 'storage_method', ''), storage_method),
    shelf_life_hours = coalesce(nullif(p_version ->> 'shelf_life_hours', '')::int, shelf_life_hours),
    notes = coalesce(p_version ->> 'notes', '')
  where id = p_version_id;

  for line, line_no in
    select x.value, x.n from jsonb_array_elements(coalesce(p_version -> 'lines', '[]'::jsonb)) with ordinality x(value, n)
  loop
    v_qty := nullif(line ->> 'quantity', '')::numeric;
    if v_qty is not null and v_qty <= 0 then
      raise exception '「%」第 % 行：用量必須大於 0', p_name, line_no;
    end if;
    if nullif(line ->> 'component', '') is not null then
      if not exists (select 1 from app.recipes where type = 'component' and name = line ->> 'component') then
        raise exception '「%」引用的元件「%」不存在或尚未建立', p_name, line ->> 'component';
      end if;
      -- 有定版用定版，否則用最新的草案（CLAUDE.md §4 規則 7）
      select v.id into v_component_version
      from app.recipes r join app.recipe_versions v on v.recipe_id = r.id
      where r.type = 'component' and r.name = line ->> 'component'
        and v.status <> 'retired'
      order by (v.status = 'locked') desc, v.version_no desc
      limit 1;
      if v_component_version is null then
        warnings := warnings || format(
          '「%s」沒有帶入元件「%s」%s：這個元件的版本都停用了，之後請手動加入',
          p_name, line ->> 'component',
          case when v_qty is null then '' else ' ' || v_qty || ' ' || coalesce(nullif(line ->> 'unit', ''), 'g') end
        );
        continue;
      end if;
      v_unit := coalesce(nullif(line ->> 'unit', ''), 'g');
      if v_unit not in ('g', 'kg', '台斤', '兩', 'ml', 'L', '份') then
        raise exception '「%」第 % 行：元件用量單位必須是重量、容量或「份」', p_name, line_no;
      end if;
      insert into app.recipe_lines (version_id, sort_order, line_kind, component_version_id, quantity, unit, prep_note, group_label)
      values (p_version_id, line_no, 'component', v_component_version, v_qty, v_unit,
              coalesce(line ->> 'prep_note', ''), btrim(coalesce(line ->> 'group_label', '')));
    else
      select * into ing from app.ingredients where name = line ->> 'ingredient';
      if ing.id is null then
        raise exception '「%」使用的原物料「%」不存在', p_name, coalesce(line ->> 'ingredient', '');
      end if;
      v_unit := coalesce(nullif(line ->> 'unit', ''),
                         case ing.base_dimension when 'mass' then 'g' when 'volume' then 'ml' else 'pc' end);
      if not app.is_valid_ingredient_unit(ing.id, v_unit) then
        raise exception '「%」第 % 行：單位「%」不適用於「%」', p_name, line_no, v_unit, ing.name;
      end if;
      insert into app.recipe_lines (version_id, sort_order, line_kind, ingredient_id, quantity, unit, prep_note, group_label)
      values (p_version_id, line_no, 'ingredient', ing.id, v_qty, v_unit,
              coalesce(line ->> 'prep_note', ''), btrim(coalesce(line ->> 'group_label', '')));
    end if;
  end loop;

  for step, step_no in
    select x.value, x.n from jsonb_array_elements(coalesce(p_version -> 'steps', '[]'::jsonb)) with ordinality x(value, n)
  loop
    v_heat := nullif(step ->> 'heat_level', '');
    if v_heat is not null and v_heat not in ('high', 'medium', 'low', 'simmer') then
      raise exception '「%」第 % 個步驟：火力設定錯誤', p_name, step_no;
    end if;
    insert into app.recipe_steps (version_id, step_no, instruction, duration_minutes, temperature_c, heat_level, is_critical, critical_note)
    values (p_version_id, step_no, coalesce(step ->> 'instruction', ''),
            nullif(step ->> 'duration_minutes', '')::numeric, nullif(step ->> 'temperature_c', '')::numeric,
            v_heat, coalesce((step ->> 'is_critical')::boolean, false), coalesce(step ->> 'critical_note', ''));
  end loop;
  return warnings;
end
$$;

create or replace function public.import_baseline(p_file jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := app.require_role('founder');
  item jsonb;
  recipe jsonb;
  version_data jsonb;
  created_recipe jsonb;
  existing app.recipes;
  latest app.recipe_versions;
  v_version_id uuid;
  v_version_no int;
  v_old_name text;
  v_source text := coalesce(nullif(btrim(p_file ->> 'source'), ''), '配方表');
  recipe_type text;
  recipe_name text;
  created_ingredients int := 0;
  skipped_ingredients int := 0;
  created_recipes int := 0;
  updated_recipes int := 0;
  skipped_recipes int := 0;
  warnings text[] := '{}';
  changes text[] := '{}';
begin
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
    version_data := coalesce(recipe -> 'version', '{}'::jsonb);

    select * into existing from app.recipes where type = recipe_type and name = recipe_name;
    if existing.id is null and jsonb_typeof(recipe -> 'previous_names') = 'array' then
      select r.* into existing
      from jsonb_array_elements_text(recipe -> 'previous_names') with ordinality p(name, n)
      join app.recipes r on r.type = recipe_type and r.name = btrim(p.name)
      order by p.n
      limit 1;
      if existing.id is not null then
        v_old_name := existing.name;
        update app.recipes set name = recipe_name where id = existing.id;
        changes := changes || format('「%s」改名為「%s」', v_old_name, recipe_name);
      end if;
    end if;

    if existing.id is not null then
      -- 和最新、還沒停用的版本比較
      select * into latest from app.recipe_versions
      where recipe_id = existing.id
      order by (status = 'retired'), version_no desc
      limit 1;
      if not app.import_has_new_content(latest.id, version_data) then
        skipped_recipes := skipped_recipes + 1;
        continue;
      end if;
      update app.recipes set next_version_no = next_version_no + 1
      where id = existing.id
      returning next_version_no - 1 into v_version_no;
      insert into app.recipe_versions (
        recipe_id, version_no, title, based_on_version_id, change_note, batch_output_qty, batch_output_unit,
        serving_qty, serving_unit, output_density_g_per_ml, prep_minutes, cook_minutes, storage_method, shelf_life_hours
      ) values (
        existing.id, v_version_no, '', latest.id, '', latest.batch_output_qty, latest.batch_output_unit,
        latest.serving_qty, latest.serving_unit, latest.output_density_g_per_ml, latest.prep_minutes, latest.cook_minutes,
        latest.storage_method, latest.shelf_life_hours
      )
      returning id into v_version_id;
      insert into app.version_status_history (version_id, from_status, to_status, actor_id, comment)
      values (v_version_id, null, 'draft', uid, format('依「%s」更新（接續 v%s）', v_source, latest.version_no));
      warnings := warnings || app.import_fill_version(
        v_version_id, recipe_type, recipe_name,
        version_data || jsonb_build_object('title', '配方表更新', 'change_note', format('依「%s」更新', v_source))
      );
      updated_recipes := updated_recipes + 1;
      changes := changes || format('「%s」新增 v%s 草案（v%s 保留不變）', recipe_name, v_version_no, latest.version_no);
    else
      created_recipe := public.create_recipe(jsonb_build_object(
        'type', recipe_type, 'name', recipe_name, 'component_kind', recipe ->> 'component_kind',
        'menu_category', coalesce(recipe ->> 'menu_category', ''), 'description', coalesce(recipe ->> 'description', '')
      ));
      perform app.set_context('import_baseline');
      v_version_id := (created_recipe ->> 'version_id')::uuid;
      warnings := warnings || app.import_fill_version(v_version_id, recipe_type, recipe_name, version_data);
      created_recipes := created_recipes + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'created_ingredients', created_ingredients, 'skipped_ingredients', skipped_ingredients,
    'created_recipes', created_recipes, 'updated_recipes', updated_recipes, 'skipped_recipes', skipped_recipes,
    'changes', to_jsonb(changes), 'warnings', to_jsonb(warnings)
  );
end
$$;

-- ───────────────────────── 首頁 ─────────────────────────

create or replace function public.get_dashboard() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return jsonb_build_object(
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

-- ───────────────────────── 不再使用的功能 ─────────────────────────

-- 只移除操作用的 RPC；試菜資料表與裡面的資料都保留
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'create_tasting_session', 'update_tasting_session', 'list_tasting_sessions', 'get_tasting_session',
      'add_tasting_item', 'update_tasting_item', 'delete_tasting_item',
      'submit_feedback', 'delete_feedback', 'get_my_tasting_tasks', 'record_yield', 'list_team_members'
    )
  loop
    execute format('drop function %s', fn);
  end loop;
end
$$;

create or replace function public.assign_role(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  cur text;
begin
  perform app.require_role('founder');
  perform app.set_context('assign_role');
  if p_role not in ('founder', 'chef', 'manager', 'pending') then
    raise exception '無效的角色：%', p_role;
  end if;
  select role into cur from app.profiles where id = p_user_id for update;
  if cur is null then raise exception '找不到此帳號'; end if;
  if cur = 'founder' and p_role <> 'founder'
     and (select count(*) from app.profiles where role = 'founder' and is_active) <= 1 then
    raise exception '至少要保留一位啟用中的創辦人';
  end if;
  update app.profiles set role = p_role where id = p_user_id;
end
$$;

select app.finish_migration('20261101000019');
