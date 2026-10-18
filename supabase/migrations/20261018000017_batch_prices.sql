-- 批次輸入單價：一次輸入很多原物料的進貨金額（一頁打完、按一次儲存）。
-- 每一筆：找同一個原物料、同樣包裝數量與單位的規格，沒有就建立；這個規格設為預設（成本用這次填的價格），
-- 再新增一筆單價。整批在同一個交易裡，任一筆有問題就整批不寫入。

create or replace function public.batch_add_purchase_prices(p jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  item jsonb;
  ing app.ingredients;
  spec app.packaging_specs;
  v_date date := nullif(p ->> 'effective_date', '')::date;
  v_supplier uuid := nullif(p ->> 'supplier_id', '')::uuid;
  v_note text := coalesce(p ->> 'note', '');
  v_qty numeric;
  v_unit text;
  v_price numeric;
  added int := 0;
  skipped int := 0;
  created_specs int := 0;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('batch_add_purchase_prices');
  if v_date is null then raise exception '請填寫生效日'; end if;
  if v_supplier is not null and not exists (select 1 from app.suppliers where id = v_supplier) then
    raise exception '找不到此供應商';
  end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception '沒有要儲存的單價';
  end if;

  for item in select value from jsonb_array_elements(p -> 'items') loop
    select * into ing from app.ingredients where id = nullif(item ->> 'ingredient_id', '')::uuid;
    if ing.id is null then raise exception '找不到原物料'; end if;
    v_qty := nullif(item ->> 'pack_qty', '')::numeric;
    v_unit := coalesce(item ->> 'pack_unit', '');
    v_price := nullif(item ->> 'price', '')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception '「%」：包裝數量必須大於 0', ing.name; end if;
    if not app.is_valid_ingredient_unit(ing.id, v_unit) then
      raise exception '「%」：單位「%」不適用', ing.name, v_unit;
    end if;
    if v_price is null or v_price < 0 then raise exception '「%」：金額不能是空的或負數', ing.name; end if;

    -- 同樣包裝的規格：預設的優先，其次是啟用中、最新建立的
    select * into spec from app.packaging_specs
    where ingredient_id = ing.id and pack_qty = v_qty and pack_unit = v_unit
    order by is_default desc, is_active desc, created_at desc
    limit 1;

    if spec.id is null then
      update app.packaging_specs set is_default = false where ingredient_id = ing.id and is_default;
      insert into app.packaging_specs (ingredient_id, supplier_id, spec_name, pack_qty, pack_unit, is_default, is_active)
      values (ing.id, v_supplier,
              trim(to_char(v_qty, 'FM999999990.###'), '.') || ' ' || case v_unit when 'pc' then '個' else v_unit end,
              v_qty, v_unit, true, true)
      returning * into spec;
      created_specs := created_specs + 1;
    elsif not spec.is_default or not spec.is_active then
      update app.packaging_specs set is_default = false where ingredient_id = ing.id and is_default and id <> spec.id;
      update app.packaging_specs set is_default = true, is_active = true where id = spec.id;
    end if;

    -- 同一天、同一個金額已經記過（例如按了兩次儲存）就不重複記
    if exists (
      select 1 from app.purchase_prices
      where packaging_spec_id = spec.id and effective_date = v_date and price = v_price and not is_void
    ) then
      skipped := skipped + 1;
      continue;
    end if;
    insert into app.purchase_prices (packaging_spec_id, price, effective_date, note)
    values (spec.id, v_price, v_date, v_note);
    added := added + 1;
  end loop;

  return jsonb_build_object('added', added, 'skipped', skipped, 'created_specs', created_specs);
end
$$;

select app.finish_migration('20261018000017');
