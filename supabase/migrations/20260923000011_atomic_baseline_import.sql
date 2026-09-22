-- 基準版菜單匯入必須是單一交易：任一筆失敗時，Postgres 會回復整次呼叫。

create or replace function public.import_baseline(p_file jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  item jsonb;
  recipe jsonb;
  version_data jsonb;
  line jsonb;
  step jsonb;
  ingredient_id uuid;
  component_version_id uuid;
  created_recipe jsonb;
  recipe_id uuid;
  version_id uuid;
  created_ingredients int := 0;
  skipped_ingredients int := 0;
  created_recipes int := 0;
  skipped_recipes int := 0;
  recipe_type text;
  recipe_name text;
begin
  perform app.require_role('founder');
  perform app.set_context('import_baseline');
  if jsonb_typeof(p_file -> 'ingredients') <> 'array' or jsonb_typeof(p_file -> 'recipes') <> 'array' then
    raise exception '檔案格式不正確：必須包含 ingredients 與 recipes 陣列';
  end if;

  for item in select value from jsonb_array_elements(p_file -> 'ingredients') loop
    if btrim(coalesce(item ->> 'name', '')) = '' then raise exception '原物料缺少名稱'; end if;
    insert into app.ingredients (name, category, base_dimension, density_g_per_ml, note)
    values (
      btrim(item ->> 'name'), coalesce(nullif(item ->> 'category', ''), 'other'), item ->> 'base_dimension',
      nullif(item ->> 'density_g_per_ml', '')::numeric, coalesce(item ->> 'note', '')
    ) on conflict (name) do nothing;
    if found then created_ingredients := created_ingredients + 1; else skipped_ingredients := skipped_ingredients + 1; end if;
  end loop;

  -- 元件必須先建，讓菜品可以引用；輸入檔內的順序仍代表元件間的依賴順序。
  for recipe in
    select value from jsonb_array_elements(p_file -> 'recipes') where value ->> 'type' = 'component'
    union all
    select value from jsonb_array_elements(p_file -> 'recipes') where value ->> 'type' = 'dish'
  loop
    recipe_type := recipe ->> 'type';
    recipe_name := btrim(coalesce(recipe ->> 'name', ''));
    if recipe_type not in ('dish', 'component') or recipe_name = '' then raise exception '食譜缺少有效類型或名稱'; end if;
    if exists (select 1 from app.recipes where type = recipe_type and name = recipe_name) then
      skipped_recipes := skipped_recipes + 1;
      continue;
    end if;
    created_recipe := public.create_recipe(jsonb_build_object(
      'type', recipe_type, 'name', recipe_name, 'component_kind', recipe ->> 'component_kind',
      'menu_category', coalesce(recipe ->> 'menu_category', ''), 'description', coalesce(recipe ->> 'description', '')
    ));
    recipe_id := (created_recipe ->> 'recipe_id')::uuid;
    version_id := (created_recipe ->> 'version_id')::uuid;
    version_data := coalesce(recipe -> 'version', '{}'::jsonb);
    update app.recipe_versions set
      title = coalesce(version_data ->> 'title', ''), change_note = coalesce(version_data ->> 'change_note', ''),
      batch_output_qty = nullif(version_data ->> 'batch_output_qty', '')::numeric,
      batch_output_unit = coalesce(nullif(version_data ->> 'batch_output_unit', ''), 'g'),
      serving_qty = nullif(version_data ->> 'serving_qty', '')::numeric,
      serving_unit = coalesce(nullif(version_data ->> 'serving_unit', ''), 'g'),
      storage_method = coalesce(version_data ->> 'storage_method', ''),
      shelf_life_hours = nullif(version_data ->> 'shelf_life_hours', '')::int,
      notes = coalesce(version_data ->> 'notes', '')
    where id = version_id;

    for line in select value from jsonb_array_elements(coalesce(version_data -> 'lines', '[]'::jsonb)) loop
      if nullif(line ->> 'component', '') is not null then
        select v.id into component_version_id
        from app.recipes r join app.recipe_versions v on v.recipe_id = r.id
        where r.type = 'component' and r.name = line ->> 'component'
        order by (v.status = 'locked') desc, v.version_no desc limit 1;
        if component_version_id is null then raise exception '「%」引用的元件「%」不存在或尚未建立', recipe_name, line ->> 'component'; end if;
        insert into app.recipe_lines (version_id, line_kind, component_version_id, quantity, unit, prep_note, group_label)
        values (version_id, 'component', component_version_id, nullif(line ->> 'quantity', '')::numeric,
          coalesce(line ->> 'unit', 'g'), coalesce(line ->> 'prep_note', ''), coalesce(line ->> 'group_label', ''));
      else
        select id into ingredient_id from app.ingredients where name = line ->> 'ingredient';
        if ingredient_id is null then raise exception '「%」使用的原物料「%」不存在', recipe_name, coalesce(line ->> 'ingredient', ''); end if;
        insert into app.recipe_lines (version_id, line_kind, ingredient_id, quantity, unit, prep_note, group_label)
        values (version_id, 'ingredient', ingredient_id, nullif(line ->> 'quantity', '')::numeric,
          coalesce(line ->> 'unit', 'g'), coalesce(line ->> 'prep_note', ''), coalesce(line ->> 'group_label', ''));
      end if;
    end loop;
    for step in select value from jsonb_array_elements(coalesce(version_data -> 'steps', '[]'::jsonb)) loop
      insert into app.recipe_steps (version_id, step_no, instruction, duration_minutes, temperature_c, heat_level, is_critical, critical_note)
      values (version_id, coalesce((step ->> 'step_no')::int, 1), coalesce(step ->> 'instruction', ''),
        nullif(step ->> 'duration_minutes', '')::numeric, nullif(step ->> 'temperature_c', '')::numeric,
        nullif(step ->> 'heat_level', ''), coalesce((step ->> 'is_critical')::boolean, false), coalesce(step ->> 'critical_note', ''));
    end loop;
    if coalesce((recipe ->> 'to_testing')::boolean, false) then
      perform public.transition_version(version_id, 'testing', '由基準版菜單匯入');
    end if;
    created_recipes := created_recipes + 1;
  end loop;
  return jsonb_build_object(
    'created_ingredients', created_ingredients, 'skipped_ingredients', skipped_ingredients,
    'created_recipes', created_recipes, 'skipped_recipes', skipped_recipes
  );
end
$$;

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;
