-- 已定版版本的步驟說明文字可以直接修改（使用者 2026-11-01 決定）：改錯字、補一句說明不用出新版本。
-- 只放行 instruction 一個欄位；時間、溫度、火力、關鍵管制點、步驟順序、新增與刪除步驟都維持凍結。
-- 已停用的版本完全不能改。修改由 audit trigger 留下前後內容。

create or replace function app.guard_version_child() returns trigger
language plpgsql as $$
declare
  st text;
begin
  if tg_table_name = 'recipe_steps' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'instruction' - 'updated_at') = (to_jsonb(old) - 'instruction' - 'updated_at')
     and (select status from app.recipe_versions where id = old.version_id) = 'locked' then
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into st from app.recipe_versions where id = old.version_id;
    if st is not null and st <> 'draft' then perform app.frozen_error(st); end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into st from app.recipe_versions where id = new.version_id;
    if st is not null and st <> 'draft' then perform app.frozen_error(st); end if;
  end if;
  return coalesce(new, old);
end
$$;

create or replace function public.update_locked_step(p_step_id uuid, p_instruction text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  st text;
begin
  perform app.require_role('founder', 'chef');
  perform app.set_context('update_locked_step');
  select v.status into st
  from app.recipe_steps s join app.recipe_versions v on v.id = s.version_id
  where s.id = p_step_id;
  if st is null then raise exception '找不到此步驟'; end if;
  if st <> 'locked' then raise exception '只有已定版的版本可以直接改步驟文字'; end if;
  if btrim(coalesce(p_instruction, '')) = '' then raise exception '步驟說明不能空白'; end if;
  update app.recipe_steps set instruction = btrim(p_instruction) where id = p_step_id;
end
$$;

select app.finish_migration('20261101000020');
