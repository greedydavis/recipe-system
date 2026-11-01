import type { CostView } from './costing';
import { D, type Dec } from '../domain/decimal';
import type { Dashboard, RecipeListItem } from '../data/types';
import type { VersionStatus } from '../domain/types';
import { COMPONENT_KIND_LABEL } from '../i18n/labels';

/** 一個食譜「目前的樣子」：有定版就看定版，否則看最新版本 */
export interface CurrentVersion {
  recipe: RecipeListItem;
  versionId: string;
  versionNo: number;
  stage: VersionStatus;
}

export interface CategoryProgress {
  category: string;
  total: number;
  counts: Record<VersionStatus, number>;
}

export type BlockerKind =
  | 'missing_price'
  | 'missing_quantity'
  | 'missing_yield'
  | 'not_locked'
  | 'outdated_component';

export interface BlockerGroup {
  kind: BlockerKind;
  title: string;
  hint: string;
  /** 要處理的對象；to 是點進去的路徑 */
  items: Array<{ id: string; label: string; to: string }>;
}

export interface CostRow {
  recipeId: string;
  name: string;
  category: string;
  stage: VersionStatus;
  versionId: string;
  versionNo: number;
  servingCost: Dec | null;
  /** 成本不完整時的下限（只加總算得出來的部分） */
  minServingCost: Dec | null;
  minFoodCostRate: Dec | null;
  price: number | null;
  foodCostRate: Dec | null;
  suggestedPrice: Dec | null;
  targetRate: Dec | null;
  overTarget: boolean;
  complete: boolean;
}

export interface ProgressSummary {
  dishes: { total: number; locked: number };
  components: { total: number; locked: number };
  categories: CategoryProgress[];
  blockers: BlockerGroup[];
  blockerCount: number;
  costRows: CostRow[];
  costStats: { complete: number; incomplete: number; overTarget: number; avgFoodCostRate: Dec | null; priced: number };
}

const EMPTY_COUNTS = (): Record<VersionStatus, number> => ({
  draft: 0,
  testing: 0,
  pending_approval: 0,
  locked: 0,
  retired: 0,
});

export function currentVersions(recipes: RecipeListItem[]): CurrentVersion[] {
  return recipes.map((recipe) => {
    const pick = recipe.locked ?? recipe.latest;
    return {
      recipe,
      versionId: pick.id,
      versionNo: pick.version_no,
      stage: recipe.locked ? 'locked' : recipe.latest.status,
    };
  });
}

/** 首頁與進度頁共用：把食譜、成本與首頁資料彙整成進度、卡關與成本總覽 */
export function summarizeProgress(
  recipes: RecipeListItem[],
  views: Map<string, CostView> | null,
  dashboard: Dashboard | undefined,
): ProgressSummary {
  const current = currentVersions(recipes);
  const dishes = current.filter((c) => c.recipe.type === 'dish');
  const components = current.filter((c) => c.recipe.type === 'component');

  const byCategory = new Map<string, CategoryProgress>();
  for (const c of current) {
    const category =
      c.recipe.type === 'dish'
        ? c.recipe.menu_category || '未分類'
        : `元件・${COMPONENT_KIND_LABEL[c.recipe.component_kind ?? 'other']}`;
    const entry = byCategory.get(category) ?? { category, total: 0, counts: EMPTY_COUNTS() };
    entry.total += 1;
    entry.counts[c.stage] += 1;
    byCategory.set(category, entry);
  }

  const versionLink = (c: CurrentVersion) => `/versions/${c.versionId}`;
  const hasIssue = (c: CurrentVersion, match: (issue: string) => boolean) =>
    (views?.get(c.versionId)?.cost.issues ?? []).some(match);

  const missingQuantity = current.filter((c) => hasIssue(c, (i) => i.includes('用量待填')));
  const missingYield = current.filter((c) => hasIssue(c, (i) => i.includes('產量未填') || i.includes('每份量未填')));
  const notLocked = current.filter((c) => c.stage === 'draft');

  const allGroups: BlockerGroup[] = [
    {
      kind: 'missing_price',
      title: '原物料沒有單價',
      hint: '沒有單價就算不出完整成本；可以先定版，之後再補',
      items: (dashboard?.missing_price_ingredients ?? []).map((i) => ({
        id: i.id,
        label: i.name,
        to: `/ingredients/${i.id}`,
      })),
    },
    {
      kind: 'missing_quantity',
      title: '用料的用量還沒填',
      hint: '定版前要填齊',
      items: missingQuantity.map((c) => ({ id: c.versionId, label: `${c.recipe.name} v${c.versionNo}`, to: versionLink(c) })),
    },
    {
      kind: 'missing_yield',
      title: '產量還沒填',
      hint: '定版前要填齊',
      items: missingYield.map((c) => ({ id: c.versionId, label: `${c.recipe.name} v${c.versionNo}`, to: versionLink(c) })),
    },
    {
      kind: 'not_locked',
      title: '還沒定版',
      hint: '內容填齊後，由創辦人按「定版」',
      items: notLocked.map((c) => ({ id: c.versionId, label: `${c.recipe.name} v${c.versionNo}`, to: versionLink(c) })),
    },
    {
      kind: 'outdated_component',
      title: '引用的元件版本已被取代',
      hint: '要更新請建立新版本',
      items: (dashboard?.outdated_references ?? []).map((r) => ({
        id: `${r.version_id}-${r.component_name}`,
        label: `${r.recipe_name} v${r.version_no}（${r.component_name} v${r.component_version_no}）`,
        to: `/versions/${r.version_id}`,
      })),
    },
  ];
  const groups = allGroups.filter((g) => g.items.length > 0);

  const costRows: CostRow[] = dishes.map((c) => {
    const view = views?.get(c.versionId);
    return {
      recipeId: c.recipe.id,
      name: c.recipe.name,
      category: c.recipe.menu_category || '未分類',
      stage: c.stage,
      versionId: c.versionId,
      versionNo: c.versionNo,
      servingCost: view?.cost.servingCost ?? null,
      minServingCost: view?.cost.minServingCost ?? null,
      minFoodCostRate: view?.minMetrics.foodCostRate ?? null,
      price: c.recipe.current_price?.price ?? null,
      foodCostRate: view?.metrics.foodCostRate ?? null,
      suggestedPrice: view?.metrics.suggestedPrice ?? null,
      targetRate: view?.metrics.targetRate ?? null,
      overTarget: view?.metrics.overTarget ?? false,
      complete: view?.cost.isComplete ?? false,
    };
  });

  const rates = costRows.map((r) => r.foodCostRate).filter((r): r is Dec => !!r);
  return {
    dishes: { total: dishes.length, locked: dishes.filter((c) => c.stage === 'locked').length },
    components: { total: components.length, locked: components.filter((c) => c.stage === 'locked').length },
    categories: [...byCategory.values()],
    blockers: groups,
    blockerCount: groups.reduce((n, g) => n + g.items.length, 0),
    costRows,
    costStats: {
      complete: costRows.filter((r) => r.complete).length,
      incomplete: costRows.filter((r) => !r.complete).length,
      overTarget: costRows.filter((r) => r.overTarget).length,
      priced: costRows.filter((r) => r.price !== null).length,
      avgFoodCostRate: rates.length ? rates.reduce((sum, r) => sum.add(r), new D(0)).div(rates.length) : null,
    },
  };
}
