import { rpc } from './api';
import type { IngredientListItem, RecipeListItem } from './types';

export interface BaselineLine {
  ingredient?: string;
  component?: string;
  quantity: number | null;
  unit: string;
  prep_note?: string;
  group_label?: string;
}

export interface BaselineStep {
  instruction: string;
  duration_minutes?: number | null;
  heat_level?: string | null;
  is_critical?: boolean;
  critical_note?: string;
}

export interface BaselineVersion {
  title: string;
  change_note?: string;
  batch_output_qty?: number | null;
  batch_output_unit?: 'g' | 'ml';
  serving_qty?: number | null;
  serving_unit?: 'g' | 'ml';
  storage_method?: string;
  shelf_life_hours?: number | null;
  notes?: string;
  lines: BaselineLine[];
  steps: BaselineStep[];
}

export interface BaselineRecipe {
  name: string;
  type: 'dish' | 'component';
  component_kind?: string;
  menu_category?: string;
  description?: string;
  to_testing?: boolean;
  version: BaselineVersion;
}

export interface BaselineFile {
  source: string;
  generated_at: string;
  ingredients: Array<{
    name: string;
    category: string;
    base_dimension: 'mass' | 'volume' | 'count';
    density_g_per_ml?: number | null;
    note?: string;
  }>;
  recipes: BaselineRecipe[];
}

/** 依序以目前登入者（創辦人）身分呼叫 RPC 匯入；同名資料略過 */
export async function importBaseline(file: BaselineFile, log: (line: string) => void): Promise<void> {
  if (!Array.isArray(file.ingredients) || !Array.isArray(file.recipes)) throw new Error('檔案格式不正確');
  log(`來源：${file.source}（${file.generated_at}）`);

  const existing = await rpc<IngredientListItem[]>('list_ingredients', { p_q: null, p_category: null, p_include_inactive: true });
  const ingredientIds = new Map(existing.map((i) => [i.name, i.id]));
  let created = 0;
  for (const ing of file.ingredients) {
    if (ingredientIds.has(ing.name)) continue;
    const id = await rpc<string>('upsert_ingredient', {
      p: {
        name: ing.name,
        category: ing.category,
        base_dimension: ing.base_dimension,
        density_g_per_ml: ing.density_g_per_ml ?? '',
        note: ing.note ?? '',
      },
    });
    ingredientIds.set(ing.name, id);
    created++;
  }
  log(`原物料：新增 ${created} 項，已存在 ${file.ingredients.length - created} 項`);

  const recipes = await rpc<RecipeListItem[]>('list_recipes', { p_type: null, p_q: null, p_include_archived: true });
  const existingNames = new Set(recipes.map((r) => `${r.type}:${r.name}`));
  const componentVersions = new Map<string, string>();
  for (const r of recipes) {
    if (r.type === 'component') componentVersions.set(r.name, r.locked?.id ?? r.latest.id);
  }

  // 元件先建立（菜品會引用）
  const ordered = [...file.recipes.filter((r) => r.type === 'component'), ...file.recipes.filter((r) => r.type === 'dish')];
  for (const recipe of ordered) {
    if (existingNames.has(`${recipe.type}:${recipe.name}`)) {
      log(`略過（已存在）：${recipe.name}`);
      continue;
    }
    const res = await rpc<{ recipe_id: string; version_id: string }>('create_recipe', {
      p: {
        type: recipe.type,
        name: recipe.name,
        component_kind: recipe.component_kind ?? null,
        menu_category: recipe.menu_category ?? '',
        description: recipe.description ?? '',
      },
    });
    const v = recipe.version;
    const lines = v.lines.map((l) => {
      if (l.component) {
        const cid = componentVersions.get(l.component);
        if (!cid) throw new Error(`「${recipe.name}」引用的元件「${l.component}」不存在`);
        return { id: crypto.randomUUID(), line_kind: 'component', component_version_id: cid, quantity: l.quantity ?? '', unit: l.unit, prep_note: l.prep_note ?? '', group_label: l.group_label ?? '' };
      }
      const iid = ingredientIds.get(l.ingredient ?? '');
      if (!iid) throw new Error(`「${recipe.name}」使用的原物料「${l.ingredient}」不存在`);
      return { id: crypto.randomUUID(), line_kind: 'ingredient', ingredient_id: iid, quantity: l.quantity ?? '', unit: l.unit, prep_note: l.prep_note ?? '', group_label: l.group_label ?? '' };
    });
    await rpc('save_version_draft', {
      p_version_id: res.version_id,
      p_revision: 1,
      p: {
        title: v.title,
        change_note: v.change_note ?? '',
        batch_output_qty: v.batch_output_qty ?? '',
        batch_output_unit: v.batch_output_unit ?? 'g',
        serving_qty: v.serving_qty ?? '',
        serving_unit: v.serving_unit ?? 'g',
        storage_method: v.storage_method ?? '',
        shelf_life_hours: v.shelf_life_hours ?? '',
        notes: v.notes ?? '',
        lines,
        steps: v.steps.map((s) => ({ id: crypto.randomUUID(), ...s, duration_minutes: s.duration_minutes ?? '', heat_level: s.heat_level ?? '' })),
      },
    });
    let status = '草案';
    if (recipe.to_testing) {
      try {
        await rpc('transition_version', { p_version_id: res.version_id, p_to: 'testing', p_comment: '' });
        status = '試菜中';
      } catch (e) {
        log(`⚠ ${recipe.name} 無法送試菜：${(e as Error).message}`);
      }
    }
    if (recipe.type === 'component') componentVersions.set(recipe.name, res.version_id);
    log(`✔ ${recipe.type === 'dish' ? '菜品' : '元件'}「${recipe.name}」v1（${status}，${lines.length} 行用料）`);
  }
}
