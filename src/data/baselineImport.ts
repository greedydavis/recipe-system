import { rpc } from './api';

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

/** 由單一資料庫交易匯入；任一筆失敗都不會留下部分資料。 */
export async function importBaseline(file: BaselineFile, log: (line: string) => void): Promise<void> {
  if (!Array.isArray(file.ingredients) || !Array.isArray(file.recipes)) throw new Error('檔案格式不正確');
  log(`來源：${file.source}（${file.generated_at}）`);
  const result = await rpc<{ created_ingredients: number; skipped_ingredients: number; created_recipes: number; skipped_recipes: number }>(
    'import_baseline',
    { p_file: file },
  );
  log(`原物料：新增 ${result.created_ingredients} 項，已存在 ${result.skipped_ingredients} 項`);
  log(`食譜：新增 ${result.created_recipes} 項，已存在 ${result.skipped_recipes} 項`);
}
