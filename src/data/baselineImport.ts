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
  /** 系統裡還是這些舊名稱時，先改名再當成同一個食譜的新版本 */
  previous_names?: string[];
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

interface ImportResult {
  created_ingredients: number;
  skipped_ingredients: number;
  created_recipes: number;
  /** 已存在、配方表有新內容，所以多了一個草案版本的食譜 */
  updated_recipes: number;
  skipped_recipes: number;
  /** 改名、新增了哪個版本 */
  changes?: string[];
  /** 例如「無法送試菜，保留為草案」；資料已經匯入，只是需要人工處理 */
  warnings?: string[];
}

/**
 * 由單一資料庫交易匯入；任一筆失敗都不會留下部分資料，可以安全重試。
 * 同名的原物料會略過；同名的食譜只有在檔案有新內容時才多一個草案版本，舊版本不會被覆蓋。
 */
export async function importBaseline(file: BaselineFile, log: (line: string) => void): Promise<void> {
  if (!file || !Array.isArray(file.ingredients) || !Array.isArray(file.recipes)) {
    throw new Error('檔案格式不正確：必須包含 ingredients 與 recipes');
  }
  log(`來源：${file.source}（${file.generated_at}）`);
  const result = await rpc<ImportResult>('import_baseline', { p_file: file });
  log(`原物料：新增 ${result.created_ingredients} 項，已存在 ${result.skipped_ingredients} 項`);
  log(`食譜：新增 ${result.created_recipes} 項，更新 ${result.updated_recipes} 項（新增草案版本），沒有變動 ${result.skipped_recipes} 項`);
  for (const c of result.changes ?? []) log(`・${c}`);
  for (const w of result.warnings ?? []) log(`⚠ ${w}`);
}
