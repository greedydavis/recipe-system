-- 預設包裝規格一定是啟用中：成本只看預設規格，停用的規格不該還在被拿來算成本。
-- 要停用目前的預設規格，先把另一個規格設為預設。

create or replace function app.guard_default_spec_active() returns trigger
language plpgsql as $$
begin
  if new.is_default and not new.is_active then
    raise exception '預設規格不能停用；請先把另一個規格設為預設，再停用這個' using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists guard_default_spec_active on app.packaging_specs;
create trigger guard_default_spec_active before insert or update on app.packaging_specs
  for each row execute function app.guard_default_spec_active();

select app.finish_migration('20261002000013');
