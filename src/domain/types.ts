export type Dimension = 'mass' | 'volume' | 'count';
export type RecipeType = 'dish' | 'component';
export type ComponentKind = 'soup' | 'sauce' | 'topping' | 'noodle' | 'other';
export type VersionStatus = 'draft' | 'testing' | 'pending_approval' | 'locked' | 'retired';
export type Role = 'founder' | 'chef' | 'manager' | 'tester' | 'pending';
export type OutputUnit = 'g' | 'ml';
export type LineKind = 'ingredient' | 'component';
export type NumLike = number | string;

export interface IngredientUnit {
  id?: string;
  unit_name: string;
  qty_in_base: NumLike;
  note?: string;
}

export interface PriceRef {
  id: string;
  price: NumLike;
  effective_date: string;
}

export interface DefaultSpec {
  id: string;
  spec_name: string;
  pack_qty: NumLike;
  pack_unit: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  price: PriceRef | null;
}

export interface CostingIngredient {
  id: string;
  code?: string;
  name: string;
  category?: string;
  base_dimension: Dimension;
  default_waste_rate: NumLike;
  density_g_per_ml: NumLike | null;
  units: IngredientUnit[];
  default_spec: DefaultSpec | null;
}

export interface CostingLine {
  id: string;
  line_kind: LineKind;
  ingredient_id: string | null;
  component_version_id: string | null;
  quantity: NumLike | null;
  unit: string;
  waste_rate_override: NumLike | null;
  group_label?: string;
  prep_note?: string;
  sort_order?: number;
}

export interface CostingVersion {
  id: string;
  recipe_id: string;
  recipe_type: RecipeType;
  recipe_name: string;
  recipe_code?: string;
  version_no: number;
  status: VersionStatus;
  batch_output_qty: NumLike | null;
  batch_output_unit: OutputUnit | null;
  serving_qty: NumLike | null;
  serving_unit: OutputUnit | null;
  output_density_g_per_ml: NumLike | null;
  menu_price: { id?: string; price: NumLike; effective_date?: string } | null;
  target_food_cost_rate: NumLike | null;
  lines: CostingLine[];
}

export interface Settings {
  target_food_cost_rate: number;
  sales_tax_rate: number;
  price_round_to: number;
  require_tasting_before_approval: boolean;
}

export interface CostingBundle {
  as_of: string;
  settings: Settings;
  versions: Record<string, CostingVersion>;
  ingredients: Record<string, CostingIngredient>;
}
