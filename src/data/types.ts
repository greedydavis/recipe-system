import type {
  ComponentKind,
  CostingIngredient,
  Dimension,
  LineKind,
  NumLike,
  OutputUnit,
  RecipeType,
  Role,
  Settings,
  VersionStatus,
} from '../domain/types';

export type { Settings };

export interface Me {
  id: string;
  display_name: string;
  role: Role;
  is_active: boolean;
}

export interface TeamMember {
  id: string;
  display_name: string;
  role: Role;
}

export interface Profile extends TeamMember {
  is_active: boolean;
  created_at: string;
}

export interface Unit {
  code: string;
  name_zh: string;
  dimension: Dimension;
  factor_to_base: NumLike;
  sort_order: number;
}

export interface IngredientListItem extends CostingIngredient {
  code: string;
  category: string;
  note: string;
  is_active: boolean;
  used_in_count: number;
}

export interface PriceRow {
  id: string;
  price: number;
  effective_date: string;
  is_void: boolean;
  void_reason: string | null;
  note: string;
  created_at: string;
  created_by_name: string | null;
}

export interface SpecRow {
  id: string;
  spec_name: string;
  pack_qty: number;
  pack_unit: string;
  supplier_id: string | null;
  supplier_name: string | null;
  is_default: boolean;
  is_active: boolean;
  note: string;
  prices: PriceRow[];
}

export interface UsedInRow {
  recipe_id: string;
  recipe_name: string;
  recipe_type: RecipeType;
  version_id: string;
  version_no: number;
  status: VersionStatus;
}

export interface IngredientDetail extends IngredientListItem {
  specs: SpecRow[];
  used_in: UsedInRow[];
}

export interface Supplier {
  id: string;
  name: string;
  contact_name: string;
  phone: string;
  note: string;
  is_active: boolean;
  spec_count?: number;
}

export interface SupplierDetail extends Supplier {
  specs: Array<{
    id: string;
    spec_name: string;
    ingredient_id: string;
    ingredient_name: string;
    is_default: boolean;
    is_active: boolean;
    latest_price: { price: number; effective_date: string } | null;
  }>;
}

export interface MenuPriceRef {
  id: string;
  price: number;
  effective_date: string;
}

export interface RecipeListItem {
  id: string;
  code: string;
  type: RecipeType;
  component_kind: ComponentKind | null;
  menu_category: string;
  name: string;
  description: string;
  is_archived: boolean;
  target_food_cost_rate: number | null;
  current_price: MenuPriceRef | null;
  locked: { id: string; version_no: number; title: string; approved_at: string } | null;
  latest: { id: string; version_no: number; title: string; status: VersionStatus; updated_at: string };
  version_count: number;
  has_outdated_components: boolean;
  updated_at: string;
}

export interface VersionSummary {
  id: string;
  recipe_id: string;
  version_no: number;
  title: string;
  status: VersionStatus;
  based_on_version_id: string | null;
  based_on_version_no: number | null;
  change_note: string;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
  submitted_at: string | null;
  submitted_by_name: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  retired_at: string | null;
  retired_by_name: string | null;
  retire_reason: string | null;
  superseded_by_version_id: string | null;
  superseded_by_version_no: number | null;
  tasting_item_count: number;
  feedback_count: number;
  avg_overall: number | null;
}

export interface RecipeDetail {
  id: string;
  code: string;
  type: RecipeType;
  component_kind: ComponentKind | null;
  menu_category: string;
  name: string;
  description: string;
  target_food_cost_rate: number | null;
  is_archived: boolean;
  current_price: MenuPriceRef | null;
  versions: VersionSummary[];
  menu_prices: Array<MenuPriceRef & { note: string; created_at: string; created_by_name: string | null }>;
  used_by: Array<{
    recipe_id: string;
    recipe_name: string;
    recipe_type: RecipeType;
    version_id: string;
    version_no: number;
    status: VersionStatus;
    component_version_id: string;
    component_version_no: number;
    component_status: VersionStatus;
  }>;
}

export interface Photo {
  id: string;
  storage_path: string;
  caption: string;
  sort_order: number;
  created_at: string;
  created_by: string | null;
}

export interface VersionLine {
  id: string;
  sort_order: number;
  group_label: string;
  line_kind: LineKind;
  ingredient_id: string | null;
  ingredient_name: string | null;
  ingredient_code: string | null;
  component_version_id: string | null;
  component_recipe_id: string | null;
  component_name: string | null;
  component_code: string | null;
  component_version_no: number | null;
  component_status: VersionStatus | null;
  component_locked_version_id: string | null;
  component_locked_version_no: number | null;
  quantity: number | null;
  unit: string;
  waste_rate_override: number | null;
  prep_note: string;
}

export interface VersionStep {
  id: string;
  step_no: number;
  instruction: string;
  duration_minutes: number | null;
  temperature_c: number | null;
  heat_level: string | null;
  is_critical: boolean;
  critical_note: string;
  photos: Photo[];
}

export interface VersionDetail extends VersionSummary {
  recipe: {
    id: string;
    code: string;
    type: RecipeType;
    component_kind: ComponentKind | null;
    menu_category: string;
    name: string;
    is_archived: boolean;
    target_food_cost_rate: number | null;
  };
  batch_output_qty: number | null;
  batch_output_unit: OutputUnit | null;
  serving_qty: number | null;
  serving_unit: OutputUnit | null;
  output_density_g_per_ml: number | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  storage_method: string;
  shelf_life_hours: number | null;
  notes: string;
  revision: number;
  lines: VersionLine[];
  steps: VersionStep[];
  photos: Photo[];
  history: Array<{
    id: string;
    from_status: VersionStatus | null;
    to_status: VersionStatus;
    comment: string;
    actor_name: string | null;
    created_at: string;
  }>;
  snapshots: Array<{
    id: string;
    reason: string;
    price_as_of: string;
    batch_cost: number | null;
    cost_per_serving: number | null;
    yield_rate: number | null;
    menu_price: number | null;
    food_cost_rate: number | null;
    is_complete: boolean;
    created_at: string;
    created_by_name: string | null;
  }>;
  tastings: Array<{
    item_id: string;
    session_id: string;
    tasted_on: string;
    session_title: string;
    blind_label: string;
    maker_name: string | null;
    deviation_note: string;
    feedback_count: number;
    avg_overall: number | null;
    avg_saltiness: number | null;
    avg_oiliness: number | null;
    issues: string[];
    suggestions: string[];
  }>;
}

export interface Feedback {
  id: string;
  tasting_item_id: string;
  taster_id: string | null;
  taster_name: string;
  taster_display: string | null;
  entered_by: string | null;
  entered_by_name: string | null;
  score_overall: number;
  score_flavor: number | null;
  score_texture: number | null;
  score_aroma: number | null;
  score_appearance: number | null;
  saltiness: number | null;
  oiliness: number | null;
  issues: string;
  suggestions: string;
  menu_ready: 'yes' | 'maybe' | 'no' | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
}

export interface TastingSessionListItem {
  id: string;
  tasted_on: string;
  title: string;
  location: string;
  item_count: number;
  feedback_count: number;
  items: Array<{ recipe_name: string; version_no: number; blind_label: string }>;
}

export interface TastingItemDetail {
  id: string;
  version_id: string;
  recipe_id: string;
  recipe_name: string;
  recipe_type: RecipeType;
  version_no: number;
  version_title: string;
  version_status: VersionStatus;
  blind_label: string;
  maker_id: string | null;
  maker_name: string | null;
  maker_name_text: string;
  deviation_note: string;
  assigned_testers: Array<{ id: string; display_name: string }>;
  photos: Photo[];
  feedback: Feedback[];
  stats: {
    count: number;
    avg_overall: number | null;
    avg_flavor: number | null;
    avg_texture: number | null;
    avg_aroma: number | null;
    avg_appearance: number | null;
    avg_saltiness: number | null;
    avg_oiliness: number | null;
    menu_ready_yes: number;
    menu_ready_maybe: number;
    menu_ready_no: number;
  };
}

export interface TastingSessionDetail {
  id: string;
  tasted_on: string;
  title: string;
  location: string;
  note: string;
  created_by_name: string | null;
  items: TastingItemDetail[];
}

export interface MyTastingTask {
  item_id: string;
  session_id: string;
  tasted_on: string;
  session_title: string;
  display_name: string;
  photos: Photo[];
  my_feedback: Feedback | null;
  can_submit: boolean;
}

export interface Dashboard {
  role: Role;
  my_open_tasting_tasks: number;
  pending_approvals?: Array<{
    version_id: string;
    recipe_id: string;
    recipe_name: string;
    recipe_type: RecipeType;
    version_no: number;
    title: string;
    submitted_at: string;
    submitted_by_name: string | null;
  }>;
  testing_versions?: Array<{
    version_id: string;
    recipe_id: string;
    recipe_name: string;
    recipe_type: RecipeType;
    version_no: number;
    title: string;
    updated_at: string;
    feedback_count: number;
  }>;
  draft_count?: number;
  missing_price_ingredients?: Array<{ id: string; name: string; code: string }>;
  outdated_references?: Array<{
    recipe_id: string;
    recipe_name: string;
    version_id: string;
    version_no: number;
    status: VersionStatus;
    component_name: string;
    component_version_no: number;
    component_locked_version_no: number | null;
  }>;
  recent_versions?: Array<{
    version_id: string;
    recipe_id: string;
    recipe_name: string;
    recipe_type: RecipeType;
    version_no: number;
    status: VersionStatus;
    updated_at: string;
  }>;
  dish_cost_versions?: Array<{ recipe_id: string; recipe_name: string; version_id: string; version_no: number; status: VersionStatus }>;
}

export interface AuditLog {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  action: 'insert' | 'update' | 'delete';
  table_name: string;
  record_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_fields: string[] | null;
  context: string | null;
}
