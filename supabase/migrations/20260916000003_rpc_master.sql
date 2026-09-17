-- 試菜與標準食譜系統：RPC — 帳號、設定、單位、原物料、供應商、包裝規格、單價

-- ───────────────────────── 帳號 ─────────────────────────

create or replace function public.me() returns jsonb
language sql stable security definer set search_path = app, pg_temp as $$
  select jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role, 'is_active', p.is_active)
  from app.profiles p
  where p.id = auth.uid()
$$;

create or replace function public.update_my_display_name(p_name text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if auth.uid() is null then raise exception '請先登入' using errcode = '28000'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception '名稱不能空白'; end if;
  update app.profiles set display_name = btrim(p_name) where id = auth.uid();
end
$$;

create or replace function public.list_profiles() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'display_name', display_name, 'role', role, 'is_active', is_active, 'created_at', created_at
    ) order by created_at)
    from app.profiles
  ), '[]'::jsonb);
end
$$;

-- 試做人、測試人員選單用
create or replace function public.list_team_members() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'display_name', display_name, 'role', role) order by display_name)
    from app.profiles
    where is_active and role <> 'pending'
  ), '[]'::jsonb);
end
$$;

create or replace function public.assign_role(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  cur text;
begin
  perform app.require_role('founder');
  perform app.set_context('assign_role');
  if p_role not in ('founder', 'chef', 'manager', 'tester', 'pending') then
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

create or replace function public.set_profile_active(p_user_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := app.require_role('founder');
begin
  perform app.set_context('set_profile_active');
  if p_user_id = uid and not p_active then raise exception '不能停用自己的帳號'; end if;
  update app.profiles set is_active = p_active where id = p_user_id;
  if not found then raise exception '找不到此帳號'; end if;
end
$$;

-- ───────────────────────── 設定與單位 ─────────────────────────

create or replace function public.get_settings() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return (select jsonb_object_agg(key, value) from app.app_settings);
end
$$;

create or replace function public.update_settings(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  k text;
  v jsonb;
begin
  perform app.require_role('founder');
  perform app.set_context('update_settings');
  for k, v in select * from jsonb_each(p_patch) loop
    case k
      when 'target_food_cost_rate' then
        if jsonb_typeof(v) <> 'number' or v::numeric <= 0 or v::numeric >= 1 then
          raise exception '目標食材成本率必須介於 0%% 與 100%% 之間';
        end if;
      when 'sales_tax_rate' then
        if jsonb_typeof(v) <> 'number' or v::numeric < 0 or v::numeric >= 1 then
          raise exception '營業稅率必須介於 0%% 與 100%% 之間';
        end if;
      when 'price_round_to' then
        if jsonb_typeof(v) <> 'number' or v::numeric <= 0 then
          raise exception '建議售價進位單位必須大於 0';
        end if;
      when 'require_tasting_before_approval' then
        if jsonb_typeof(v) <> 'boolean' then raise exception '送核准前是否需要試菜紀錄必須是是／否'; end if;
      else
        raise exception '未知的設定：%', k;
    end case;
    update app.app_settings set value = v, updated_by = auth.uid() where key = k;
  end loop;
  return (select jsonb_object_agg(key, value) from app.app_settings);
end
$$;

create or replace function public.list_units() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return (select jsonb_agg(to_jsonb(u) order by sort_order) from app.units u);
end
$$;

-- ───────────────────────── 原物料 ─────────────────────────

-- 原物料的預設規格與「指定日期」有效單價
create or replace function app.ingredient_price_json(p_ingredient_id uuid, p_as_of date) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', s.id,
    'spec_name', s.spec_name,
    'pack_qty', s.pack_qty,
    'pack_unit', s.pack_unit,
    'supplier_id', s.supplier_id,
    'supplier_name', sup.name,
    'price', (
      select jsonb_build_object('id', pp.id, 'price', pp.price, 'effective_date', pp.effective_date)
      from app.purchase_prices pp
      where pp.packaging_spec_id = s.id and not pp.is_void and pp.effective_date <= p_as_of
      order by pp.effective_date desc, pp.created_at desc
      limit 1
    )
  )
  from app.packaging_specs s
  left join app.suppliers sup on sup.id = s.supplier_id
  where s.ingredient_id = p_ingredient_id and s.is_default
$$;

create or replace function app.ingredient_units_json(p_ingredient_id uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'unit_name', unit_name, 'qty_in_base', qty_in_base, 'note', note
  ) order by unit_name), '[]'::jsonb)
  from app.ingredient_units
  where ingredient_id = p_ingredient_id
$$;

create or replace function app.ingredient_json(i app.ingredients, p_as_of date) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', i.id, 'code', i.code, 'name', i.name, 'category', i.category,
    'base_dimension', i.base_dimension, 'default_waste_rate', i.default_waste_rate,
    'density_g_per_ml', i.density_g_per_ml, 'note', i.note, 'is_active', i.is_active,
    'units', app.ingredient_units_json(i.id),
    'default_spec', app.ingredient_price_json(i.id, p_as_of)
  )
$$;

create or replace function public.list_ingredients(
  p_q text default null, p_category text default null, p_include_inactive boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(
      app.ingredient_json(i, app.today()) || jsonb_build_object(
        'used_in_count', (
          select count(distinct v.recipe_id)
          from app.recipe_lines l join app.recipe_versions v on v.id = l.version_id
          where l.ingredient_id = i.id and v.status <> 'retired'
        )
      ) order by i.category, i.name)
    from app.ingredients i
    where (p_include_inactive or i.is_active)
      and (p_category is null or i.category = p_category)
      and (p_q is null or btrim(p_q) = '' or i.name ilike '%' || btrim(p_q) || '%' or i.code ilike '%' || btrim(p_q) || '%')
  ), '[]'::jsonb);
end
$$;

create or replace function public.get_ingredient(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  i app.ingredients;
begin
  perform app.require_role('founder', 'chef', 'manager');
  select * into i from app.ingredients where id = p_id;
  if i.id is null then raise exception '找不到此原物料'; end if;
  return app.ingredient_json(i, app.today()) || jsonb_build_object(
    'specs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'spec_name', s.spec_name, 'pack_qty', s.pack_qty, 'pack_unit', s.pack_unit,
        'supplier_id', s.supplier_id, 'supplier_name', sup.name, 'is_default', s.is_default,
        'is_active', s.is_active, 'note', s.note,
        'prices', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', pp.id, 'price', pp.price, 'effective_date', pp.effective_date, 'is_void', pp.is_void,
            'void_reason', pp.void_reason, 'note', pp.note, 'created_at', pp.created_at,
            'created_by_name', app.display_name(pp.created_by)
          ) order by pp.effective_date desc, pp.created_at desc)
          from app.purchase_prices pp where pp.packaging_spec_id = s.id
        ), '[]'::jsonb)
      ) order by s.is_default desc, s.created_at)
      from app.packaging_specs s
      left join app.suppliers sup on sup.id = s.supplier_id
      where s.ingredient_id = i.id
    ), '[]'::jsonb),
    'used_in', coalesce((
      select jsonb_agg(x order by x ->> 'recipe_name', (x ->> 'version_no')::int)
      from (
        select distinct jsonb_build_object(
          'recipe_id', r.id, 'recipe_name', r.name, 'recipe_type', r.type,
          'version_id', v.id, 'version_no', v.version_no, 'status', v.status
        ) as x
        from app.recipe_lines l
        join app.recipe_versions v on v.id = l.version_id
        join app.recipes r on r.id = v.recipe_id
        where l.ingredient_id = i.id and v.status <> 'retired'
      ) sub
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.upsert_ingredient(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  cur app.ingredients;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_ingredient');
  if btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫原物料名稱'; end if;
  if coalesce(p ->> 'base_dimension', '') not in ('mass', 'volume', 'count') then
    raise exception '請選擇基本單位（公克、毫升或個）';
  end if;

  if v_id is null then
    insert into app.ingredients (name, category, base_dimension, default_waste_rate, density_g_per_ml, note, is_active)
    values (
      btrim(p ->> 'name'),
      coalesce(nullif(p ->> 'category', ''), 'other'),
      p ->> 'base_dimension',
      coalesce((p ->> 'default_waste_rate')::numeric, 0),
      nullif(p ->> 'density_g_per_ml', '')::numeric,
      coalesce(p ->> 'note', ''),
      coalesce((p ->> 'is_active')::boolean, true)
    )
    returning id into v_id;
  else
    select * into cur from app.ingredients where id = v_id for update;
    if cur.id is null then raise exception '找不到此原物料'; end if;
    if cur.base_dimension <> p ->> 'base_dimension' and (
         exists (select 1 from app.recipe_lines where ingredient_id = v_id)
         or exists (select 1 from app.packaging_specs where ingredient_id = v_id)
       ) then
      raise exception '此原物料已有包裝規格或已被食譜使用，不能變更基本單位';
    end if;
    update app.ingredients set
      name = btrim(p ->> 'name'),
      category = coalesce(nullif(p ->> 'category', ''), 'other'),
      base_dimension = p ->> 'base_dimension',
      default_waste_rate = coalesce((p ->> 'default_waste_rate')::numeric, 0),
      density_g_per_ml = nullif(p ->> 'density_g_per_ml', '')::numeric,
      note = coalesce(p ->> 'note', ''),
      is_active = coalesce((p ->> 'is_active')::boolean, true)
    where id = v_id;
  end if;
  return v_id;
exception
  when unique_violation then raise exception '已經有同名的原物料：%', p ->> 'name';
  when check_violation then raise exception '損耗率必須介於 0%% 與 100%% 之間（不含 100%%），密度必須大於 0';
end
$$;

create or replace function public.upsert_ingredient_unit(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_name text := btrim(coalesce(p ->> 'unit_name', ''));
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_ingredient_unit');
  if v_name = '' then raise exception '請填寫單位名稱'; end if;
  if exists (select 1 from app.units where code = v_name) then
    raise exception '「%」是系統內建單位，不需要另外設定', v_name;
  end if;
  if coalesce((p ->> 'qty_in_base')::numeric, 0) <= 0 then raise exception '換算量必須大於 0'; end if;
  if v_id is null then
    insert into app.ingredient_units (ingredient_id, unit_name, qty_in_base, note)
    values ((p ->> 'ingredient_id')::uuid, v_name, (p ->> 'qty_in_base')::numeric, coalesce(p ->> 'note', ''))
    returning id into v_id;
  else
    update app.ingredient_units
    set unit_name = v_name, qty_in_base = (p ->> 'qty_in_base')::numeric, note = coalesce(p ->> 'note', '')
    where id = v_id;
    if not found then raise exception '找不到此單位'; end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception '此原物料已經有「%」這個單位', v_name;
end
$$;

create or replace function public.delete_ingredient_unit(p_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  u app.ingredient_units;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('delete_ingredient_unit');
  select * into u from app.ingredient_units where id = p_id;
  if u.id is null then raise exception '找不到此單位'; end if;
  if exists (select 1 from app.recipe_lines where ingredient_id = u.ingredient_id and unit = u.unit_name)
     or exists (select 1 from app.packaging_specs where ingredient_id = u.ingredient_id and pack_unit = u.unit_name) then
    raise exception '「%」已被食譜或包裝規格使用，不能刪除', u.unit_name;
  end if;
  delete from app.ingredient_units where id = p_id;
end
$$;

-- 單位是否適用於此原物料（系統單位或原物料專屬單位）
create or replace function app.is_valid_ingredient_unit(p_ingredient_id uuid, p_unit text) returns boolean
language sql stable as $$
  select exists (select 1 from app.units where code = p_unit)
      or exists (select 1 from app.ingredient_units where ingredient_id = p_ingredient_id and unit_name = p_unit)
$$;

-- ───────────────────────── 供應商 ─────────────────────────

create or replace function public.list_suppliers(p_q text default null, p_include_inactive boolean default false) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_role('founder', 'chef', 'manager');
  return coalesce((
    select jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'spec_count', (select count(*) from app.packaging_specs ps where ps.supplier_id = s.id)
    ) order by s.name)
    from app.suppliers s
    where (p_include_inactive or s.is_active)
      and (p_q is null or btrim(p_q) = '' or s.name ilike '%' || btrim(p_q) || '%')
  ), '[]'::jsonb);
end
$$;

create or replace function public.get_supplier(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  s app.suppliers;
begin
  perform app.require_role('founder', 'chef', 'manager');
  select * into s from app.suppliers where id = p_id;
  if s.id is null then raise exception '找不到此供應商'; end if;
  return to_jsonb(s) || jsonb_build_object(
    'specs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ps.id, 'spec_name', ps.spec_name, 'ingredient_id', i.id, 'ingredient_name', i.name,
        'is_default', ps.is_default, 'is_active', ps.is_active,
        'latest_price', (
          select jsonb_build_object('price', pp.price, 'effective_date', pp.effective_date)
          from app.purchase_prices pp
          where pp.packaging_spec_id = ps.id and not pp.is_void and pp.effective_date <= app.today()
          order by pp.effective_date desc, pp.created_at desc limit 1
        )
      ) order by i.name)
      from app.packaging_specs ps join app.ingredients i on i.id = ps.ingredient_id
      where ps.supplier_id = s.id
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.upsert_supplier(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_supplier');
  if btrim(coalesce(p ->> 'name', '')) = '' then raise exception '請填寫供應商名稱'; end if;
  if v_id is null then
    insert into app.suppliers (name, contact_name, phone, note, is_active)
    values (btrim(p ->> 'name'), coalesce(p ->> 'contact_name', ''), coalesce(p ->> 'phone', ''),
            coalesce(p ->> 'note', ''), coalesce((p ->> 'is_active')::boolean, true))
    returning id into v_id;
  else
    update app.suppliers set
      name = btrim(p ->> 'name'), contact_name = coalesce(p ->> 'contact_name', ''),
      phone = coalesce(p ->> 'phone', ''), note = coalesce(p ->> 'note', ''),
      is_active = coalesce((p ->> 'is_active')::boolean, true)
    where id = v_id;
    if not found then raise exception '找不到此供應商'; end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception '已經有同名的供應商：%', p ->> 'name';
end
$$;

-- ───────────────────────── 包裝規格與單價 ─────────────────────────

create or replace function public.upsert_packaging_spec(p jsonb) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_ingredient uuid;
  v_default boolean := coalesce((p ->> 'is_default')::boolean, false);
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('upsert_packaging_spec');
  if v_id is null then
    v_ingredient := (p ->> 'ingredient_id')::uuid;
  else
    select ingredient_id into v_ingredient from app.packaging_specs where id = v_id;
    if v_ingredient is null then raise exception '找不到此包裝規格'; end if;
  end if;
  if not exists (select 1 from app.ingredients where id = v_ingredient) then raise exception '找不到此原物料'; end if;
  if btrim(coalesce(p ->> 'spec_name', '')) = '' then raise exception '請填寫規格名稱，例如「20 kg/箱」'; end if;
  if coalesce((p ->> 'pack_qty')::numeric, 0) <= 0 then raise exception '包裝數量必須大於 0'; end if;
  if not app.is_valid_ingredient_unit(v_ingredient, p ->> 'pack_unit') then
    raise exception '單位「%」不適用於此原物料', p ->> 'pack_unit';
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

create or replace function public.add_purchase_price(
  p_spec_id uuid, p_price numeric, p_effective_date date, p_note text default ''
) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('add_purchase_price');
  if not exists (select 1 from app.packaging_specs where id = p_spec_id) then raise exception '找不到此包裝規格'; end if;
  if p_price is null or p_price < 0 then raise exception '單價不能是負數'; end if;
  if p_effective_date is null then raise exception '請填寫生效日'; end if;
  insert into app.purchase_prices (packaging_spec_id, price, effective_date, note)
  values (p_spec_id, p_price, p_effective_date, coalesce(p_note, ''))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.void_purchase_price(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  uid uuid := app.require_role('founder');
begin
  perform app.set_context('void_purchase_price');
  if btrim(coalesce(p_reason, '')) = '' then raise exception '請填寫作廢原因'; end if;
  update app.purchase_prices
  set is_void = true, void_reason = btrim(p_reason), voided_by = uid, voided_at = now()
  where id = p_id and not is_void;
  if not found then raise exception '找不到此單價，或已經作廢'; end if;
end
$$;
