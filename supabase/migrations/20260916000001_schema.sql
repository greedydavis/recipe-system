-- 試菜與標準食譜系統：資料表
-- 所有業務表放在不對外公開的 app schema；前端只能呼叫 public schema 的 RPC（見 0003、0004）。

create schema if not exists app;

-- ───────────────────────── 帳號與設定 ─────────────────────────

create table app.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'pending'
    check (role in ('founder', 'chef', 'manager', 'tester', 'pending')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.app_settings (
  key text primary key
    check (key in ('target_food_cost_rate', 'sales_tax_rate', 'price_round_to', 'require_tasting_before_approval')),
  value jsonb not null,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

insert into app.app_settings (key, value) values
  ('target_food_cost_rate', '0.35'),
  ('sales_tax_rate', '0.05'),
  ('price_round_to', '5'),
  ('require_tasting_before_approval', 'true');

-- ───────────────────────── 原物料與價格 ─────────────────────────

create table app.units (
  code text primary key,
  name_zh text not null,
  dimension text not null check (dimension in ('mass', 'volume', 'count')),
  factor_to_base numeric not null check (factor_to_base > 0),
  sort_order int not null default 0
);

-- 必須和 src/domain/units.ts 的 GLOBAL_UNITS 一致（db-tests 會比對）
insert into app.units (code, name_zh, dimension, factor_to_base, sort_order) values
  ('g', '公克', 'mass', 1, 10),
  ('kg', '公斤', 'mass', 1000, 20),
  ('台斤', '台斤', 'mass', 600, 30),
  ('兩', '台兩', 'mass', 37.5, 40),
  ('ml', '毫升', 'volume', 1, 50),
  ('L', '公升', 'volume', 1000, 60),
  ('大匙', '大匙', 'volume', 15, 70),
  ('小匙', '小匙', 'volume', 5, 80),
  ('pc', '個', 'count', 1, 90);

create sequence app.ingredient_code_seq;

create table app.ingredients (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('I-' || lpad(nextval('app.ingredient_code_seq')::text, 4, '0')),
  name text not null unique check (btrim(name) <> ''),
  category text not null default 'other'
    check (category in ('meat', 'seafood', 'produce', 'dry_goods', 'seasoning', 'oil', 'grain',
                        'egg_soy_dairy', 'beverage', 'packaging', 'other')),
  base_dimension text not null check (base_dimension in ('mass', 'volume', 'count')),
  default_waste_rate numeric(5, 4) not null default 0
    check (default_waste_rate >= 0 and default_waste_rate < 1),
  density_g_per_ml numeric check (density_g_per_ml > 0),
  note text not null default '',
  is_active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.ingredient_units (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references app.ingredients(id) on delete cascade,
  unit_name text not null check (btrim(unit_name) <> ''),
  qty_in_base numeric not null check (qty_in_base > 0),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ingredient_id, unit_name)
);

create table app.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (btrim(name) <> ''),
  contact_name text not null default '',
  phone text not null default '',
  note text not null default '',
  is_active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.packaging_specs (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references app.ingredients(id) on delete cascade,
  supplier_id uuid references app.suppliers(id) on delete set null,
  spec_name text not null check (btrim(spec_name) <> ''),
  pack_qty numeric not null check (pack_qty > 0),
  pack_unit text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index packaging_specs_one_default on app.packaging_specs (ingredient_id) where is_default;

create table app.purchase_prices (
  id uuid primary key default gen_random_uuid(),
  packaging_spec_id uuid not null references app.packaging_specs(id) on delete cascade,
  price numeric(12, 2) not null check (price >= 0),
  effective_date date not null,
  is_void boolean not null default false,
  void_reason text,
  voided_by uuid,
  voided_at timestamptz,
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_void or btrim(coalesce(void_reason, '')) <> '')
);

create index purchase_prices_spec_date on app.purchase_prices (packaging_spec_id, effective_date desc);

-- ───────────────────────── 食譜 ─────────────────────────

create sequence app.dish_code_seq;
create sequence app.component_code_seq;

create table app.recipes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  type text not null check (type in ('dish', 'component')),
  component_kind text check (component_kind in ('soup', 'sauce', 'topping', 'noodle', 'other')),
  menu_category text not null default '',
  name text not null check (btrim(name) <> ''),
  description text not null default '',
  target_food_cost_rate numeric(5, 4) check (target_food_cost_rate > 0 and target_food_cost_rate < 1),
  next_version_no int not null default 1,
  is_archived boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (type, name),
  check ((type = 'component') = (component_kind is not null)),
  check (type = 'dish' or target_food_cost_rate is null)
);

create table app.menu_prices (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references app.recipes(id) on delete cascade,
  price numeric(10, 0) not null check (price > 0),
  effective_date date not null,
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references app.recipes(id) on delete cascade,
  version_no int not null,
  title text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'testing', 'pending_approval', 'locked', 'retired')),
  based_on_version_id uuid references app.recipe_versions(id) on delete set null,
  change_note text not null default '',
  batch_output_qty numeric check (batch_output_qty > 0),
  batch_output_unit text check (batch_output_unit in ('g', 'ml')),
  serving_qty numeric check (serving_qty > 0),
  serving_unit text check (serving_unit in ('g', 'ml')),
  output_density_g_per_ml numeric check (output_density_g_per_ml > 0),
  prep_minutes numeric check (prep_minutes >= 0),
  cook_minutes numeric check (cook_minutes >= 0),
  storage_method text not null default '',
  shelf_life_hours int check (shelf_life_hours > 0),
  notes text not null default '',
  revision int not null default 1,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  retired_by uuid,
  retired_at timestamptz,
  retire_reason text,
  superseded_by_version_id uuid references app.recipe_versions(id) on delete set null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recipe_id, version_no)
);

-- 每個食譜同一時間最多一個已定版版本
create unique index recipe_versions_one_locked on app.recipe_versions (recipe_id) where status = 'locked';

create table app.recipe_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references app.recipe_versions(id) on delete cascade,
  sort_order int not null default 0,
  group_label text not null default '',
  line_kind text not null check (line_kind in ('ingredient', 'component')),
  ingredient_id uuid references app.ingredients(id),
  component_version_id uuid references app.recipe_versions(id),
  quantity numeric check (quantity > 0),
  unit text not null,
  waste_rate_override numeric(5, 4) check (waste_rate_override >= 0 and waste_rate_override < 1),
  prep_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (line_kind = 'ingredient' and ingredient_id is not null and component_version_id is null)
    or (line_kind = 'component' and component_version_id is not null and ingredient_id is null)
  )
);

create index recipe_lines_version on app.recipe_lines (version_id);
create index recipe_lines_component on app.recipe_lines (component_version_id);
create index recipe_lines_ingredient on app.recipe_lines (ingredient_id);

create table app.recipe_steps (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references app.recipe_versions(id) on delete cascade,
  step_no int not null check (step_no > 0),
  instruction text not null default '',
  duration_minutes numeric check (duration_minutes >= 0),
  temperature_c numeric,
  heat_level text check (heat_level in ('high', 'medium', 'low', 'simmer')),
  is_critical boolean not null default false,
  critical_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recipe_steps_version on app.recipe_steps (version_id);

create table app.version_status_history (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references app.recipe_versions(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid,
  comment text not null default '',
  created_at timestamptz not null default now()
);

create table app.cost_snapshots (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references app.recipe_versions(id) on delete cascade,
  reason text not null check (reason in ('lock', 'manual')),
  price_as_of date not null,
  batch_cost numeric,
  cost_per_serving numeric,
  yield_rate numeric,
  menu_price numeric,
  food_cost_rate numeric,
  is_complete boolean not null,
  detail jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- ───────────────────────── 試菜 ─────────────────────────

create table app.tasting_sessions (
  id uuid primary key default gen_random_uuid(),
  tasted_on date not null,
  title text not null default '',
  location text not null default '',
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.tasting_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references app.tasting_sessions(id) on delete cascade,
  version_id uuid not null references app.recipe_versions(id),
  maker_id uuid references app.profiles(id) on delete set null,
  maker_name text not null default '',
  blind_label text not null default '',
  deviation_note text not null default '',
  assigned_tester_ids uuid[] not null default '{}',
  sort_order int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, version_id)
);

create table app.tasting_feedback (
  id uuid primary key default gen_random_uuid(),
  tasting_item_id uuid not null references app.tasting_items(id) on delete cascade,
  taster_id uuid references app.profiles(id) on delete set null,
  taster_name text not null default '',
  entered_by uuid default auth.uid(),
  score_overall int not null check (score_overall between 1 and 5),
  score_flavor int check (score_flavor between 1 and 5),
  score_texture int check (score_texture between 1 and 5),
  score_aroma int check (score_aroma between 1 and 5),
  score_appearance int check (score_appearance between 1 and 5),
  saltiness int check (saltiness between -2 and 2),
  oiliness int check (oiliness between -2 and 2),
  issues text not null default '',
  suggestions text not null default '',
  menu_ready text check (menu_ready in ('yes', 'maybe', 'no')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (taster_id is not null or btrim(taster_name) <> '')
);

create unique index tasting_feedback_one_per_taster on app.tasting_feedback (tasting_item_id, taster_id)
  where taster_id is not null;

-- ───────────────────────── 照片 ─────────────────────────

create table app.photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  version_id uuid references app.recipe_versions(id) on delete cascade,
  step_id uuid references app.recipe_steps(id) on delete cascade,
  tasting_item_id uuid references app.tasting_items(id) on delete cascade,
  caption text not null default '',
  sort_order int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(version_id, step_id, tasting_item_id) = 1)
);

-- ───────────────────────── 操作紀錄 ─────────────────────────

create table app.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  table_name text not null,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  changed_fields text[],
  context text
);

create index audit_logs_record on app.audit_logs (table_name, record_id);
create index audit_logs_occurred on app.audit_logs (occurred_at desc);

-- 防禦性設定：app schema 對外完全不可見；所有資料表啟用 RLS 且不建立任何 policy（一律拒絕）。
revoke all on schema app from public;
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
  end loop;
end $$;
