import type {
  CostingBundle,
  CostingIngredient,
  CostingLine,
  CostingVersion,
  Dimension,
  IngredientUnit,
  NumLike,
  OutputUnit,
  Settings,
} from '../types';

export const DEFAULT_SETTINGS: Settings = {
  target_food_cost_rate: 0.35,
  sales_tax_rate: 0.05,
  price_round_to: 5,
  require_tasting_before_approval: true,
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function ingredient(opts: {
  name: string;
  base: Dimension;
  waste?: NumLike;
  density?: NumLike | null;
  units?: IngredientUnit[];
  spec?: { qty: NumLike; unit: string; price: NumLike | null } | null;
}): CostingIngredient {
  const id = nextId('ing');
  return {
    id,
    name: opts.name,
    base_dimension: opts.base,
    default_waste_rate: opts.waste ?? 0,
    density_g_per_ml: opts.density ?? null,
    units: opts.units ?? [],
    default_spec:
      opts.spec === null || opts.spec === undefined
        ? null
        : {
            id: nextId('spec'),
            spec_name: `${opts.spec.qty} ${opts.spec.unit}`,
            pack_qty: opts.spec.qty,
            pack_unit: opts.spec.unit,
            price:
              opts.spec.price === null
                ? null
                : { id: nextId('price'), price: opts.spec.price, effective_date: '2026-09-01' },
          },
  };
}

export function ingLine(ing: CostingIngredient, quantity: NumLike | null, unit: string, waste?: NumLike | null): CostingLine {
  return {
    id: nextId('line'),
    line_kind: 'ingredient',
    ingredient_id: ing.id,
    component_version_id: null,
    quantity,
    unit,
    waste_rate_override: waste ?? null,
  };
}

export function compLine(version: CostingVersion, quantity: NumLike | null, unit: string): CostingLine {
  return {
    id: nextId('line'),
    line_kind: 'component',
    ingredient_id: null,
    component_version_id: version.id,
    quantity,
    unit,
    waste_rate_override: null,
  };
}

export function version(opts: {
  name: string;
  type: 'dish' | 'component';
  batch?: [NumLike, OutputUnit] | null;
  serving?: [NumLike, OutputUnit] | null;
  density?: NumLike | null;
  menuPrice?: NumLike | null;
  target?: NumLike | null;
  lines: CostingLine[];
}): CostingVersion {
  const serving = opts.serving ?? null;
  const batch = opts.type === 'dish' ? serving : (opts.batch ?? null);
  return {
    id: nextId('ver'),
    recipe_id: nextId('rec'),
    recipe_type: opts.type,
    recipe_name: opts.name,
    version_no: 1,
    status: 'testing',
    batch_output_qty: batch ? batch[0] : null,
    batch_output_unit: batch ? batch[1] : null,
    serving_qty: serving ? serving[0] : null,
    serving_unit: serving ? serving[1] : null,
    output_density_g_per_ml: opts.density ?? null,
    menu_price: opts.menuPrice ? { price: opts.menuPrice } : null,
    target_food_cost_rate: opts.target ?? null,
    lines: opts.lines,
  };
}

export function bundle(
  versions: CostingVersion[],
  ingredients: CostingIngredient[],
  settings: Settings = DEFAULT_SETTINGS,
): CostingBundle {
  return {
    as_of: '2026-09-16',
    settings,
    versions: Object.fromEntries(versions.map((v) => [v.id, v])),
    ingredients: Object.fromEntries(ingredients.map((i) => [i.id, i])),
  };
}
