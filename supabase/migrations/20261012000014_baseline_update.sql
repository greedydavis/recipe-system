-- 配方表更新後可以重新匯入：
-- 1. 已存在的食譜，檔案裡有新內容（新的用量、新引用的元件、新的步驟）時，新增一個草案版本；
--    檔案只是「少了東西」時不動它，舊版本也永遠不會被覆蓋（CLAUDE.md §4）。
-- 2. 食譜可以帶 previous_names：系統裡還是舊名稱時先改名，再當成同一個食譜的新版本。
-- 3. 引用的元件已經建立、但還沒有可引用的版本（用量待填、送不了試菜）時，略過那一行並回報，
--    不讓整批匯入失敗；元件根本不存在（多半是打錯名稱）仍然整批退回。

-- 檔案裡的版本內容，有沒有 p_version_id 這個版本還沒有的東西
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
          where r.type = 'component' and r.name = l ->> 'component' and v.status in ('testing', 'pending_approval', 'locked')
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

-- 把檔案裡的版本內容寫進一個草案版本；回傳需要人工處理的提醒
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
      -- 只能引用已凍結的元件版本（CLAUDE.md §4 規則 7）；有定版用定版，否則用最新的試菜中／待核准版本
      select v.id into v_component_version
      from app.recipes r join app.recipe_versions v on v.recipe_id = r.id
      where r.type = 'component' and r.name = line ->> 'component'
        and v.status in ('testing', 'pending_approval', 'locked')
      order by (v.status = 'locked') desc, v.version_no desc
      limit 1;
      if v_component_version is null then
        warnings := warnings || format(
          '「%s」沒有帶入元件「%s」%s：這個元件還沒有可以引用的版本（要先送試菜），之後請手動加入',
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

    if coalesce((recipe ->> 'to_testing')::boolean, false) then
      -- 送試菜失敗（例如用量待填）時保留草案並回報，不讓整批匯入失敗
      begin
        perform public.transition_version(v_version_id, 'testing', format('由「%s」匯入', v_source));
      exception when others then
        warnings := warnings || format('「%s」無法送試菜，保留為草案：%s', recipe_name, sqlerrm);
      end;
      perform app.set_context('import_baseline');
    end if;
  end loop;

  return jsonb_build_object(
    'created_ingredients', created_ingredients, 'skipped_ingredients', skipped_ingredients,
    'created_recipes', created_recipes, 'updated_recipes', updated_recipes, 'skipped_recipes', skipped_recipes,
    'changes', to_jsonb(changes), 'warnings', to_jsonb(warnings)
  );
end
$$;

select app.finish_migration('20261012000014');
