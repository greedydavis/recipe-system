-- 刪除原物料：只限沒有任何食譜版本用過的（例如打錯、重複建立）。
-- 有被用過的只能停用：食譜與成本快照都會引用它，刪掉會對不上。
-- 包裝規格、單價與專屬單位會一起刪除（外鍵 on delete cascade），每一筆都會留下操作紀錄。
-- 單價平常只增不刪（追得到成本的來源）；沒被任何食譜用過的原物料，單價從沒進過成本，
-- 所以只在這個函式裡、而且只在這個交易裡放行，刪掉的內容仍完整留在 audit_logs。

create or replace function app.guard_purchase_price() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.deleting_unused_ingredient', true) = 'on' then
      return old;
    end if;
    raise exception '單價紀錄不能刪除，請改用作廢' using errcode = '42501';
  end if;
  if (old.packaging_spec_id, old.price, old.effective_date, old.note, old.created_by, old.created_at)
     is distinct from
     (new.packaging_spec_id, new.price, new.effective_date, new.note, new.created_by, new.created_at) then
    raise exception '單價紀錄不能修改，請作廢後新增一筆' using errcode = '42501';
  end if;
  if old.is_void and not new.is_void then
    raise exception '已作廢的單價不能恢復' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function public.delete_ingredient(p_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  ing app.ingredients;
  used text;
begin
  perform app.require_role('founder', 'chef', 'manager');
  perform app.set_context('delete_ingredient');
  select * into ing from app.ingredients where id = p_id;
  if ing.id is null then raise exception '找不到此原物料'; end if;

  select string_agg(label, '、') into used from (
    select distinct r.name || ' v' || v.version_no as label
    from app.recipe_lines l
    join app.recipe_versions v on v.id = l.version_id
    join app.recipes r on r.id = v.recipe_id
    where l.ingredient_id = p_id
    order by 1
    limit 5
  ) x;
  if used is not null then
    raise exception '「%」已經用在食譜裡（%），不能刪除；不想再看到可以改成停用', ing.name, used;
  end if;

  perform set_config('app.deleting_unused_ingredient', 'on', true);
  delete from app.ingredients where id = p_id;
  perform set_config('app.deleting_unused_ingredient', '', true);
end
$$;

select app.finish_migration('20261019000018');
