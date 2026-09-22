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
  | 'no_feedback'
  | 'not_in_testing'
  | 'outdated_component'
  | 'pending_approval';

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
  const notInTesting = current.filter((c) => c.stage === 'draft');
  const noFeedback = (dashboard?.testing_versions ?? []).filter((v) => v.feedback_count === 0);

  const allGroups: BlockerGroup[] = [
    {
      kind: 'missing_price',
      title: '原物料沒有單價',
      hint: '沒有單價就算不出成本，送核准會被擋下',
      items: (dashboard?.missing_price_ingredients ?? []).map((i) => ({
        id: i.id,
        label: i.name,
        to: `/ingredients/${i.id}`,
      })),
    },
    {
      kind: 'missing_quantity',
      title: '用料的用量還沒填',
      hint: '送試菜前要填齊',
      items: missingQuantity.map((c) => ({ id: c.versionId, label: `${c.recipe.name} v${c.versionNo}`, to: versionLink(c) })),
    },
    {
      kind: 'missing_yield',
      title: '還沒記錄實際產量',
      hint: '試做完秤出成品量再填；送核准前必須填',
      items: missingYield.map((c) => ({ id: c.versionId, label: `${c.recipe.name} v${c.versionNo}`, to: versionLink(c) })),
    },
    {
      kind: 'not_in_testing',
      title: '還沒送試菜',
      hint: '草案內容還會變動，要送試菜才能安排試做',
      items: notInTesting.map((c) => ({ id: c.versionId, label: `${c.recipe.name} v${c.versionNo}`, to: versionLink(c) })),
    },
    {
      kind: 'no_feedback',
      title: '試菜中但還沒有人評分',
      hint: '預設要有一筆評分才能送核准',
      items: noFeedback.map((v) => ({
        id: v.version_id,
        label: `${v.recipe_name} v${v.version_no}`,
        to: `/versions/${v.version_id}`,
      })),
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
    {
      kind: 'pending_approval',
      title: '等創辦人核准',
      hint: '核准後就成為現行定版',
      items: (dashboard?.pending_approvals ?? []).map((v) => ({
        id: v.version_id,
        label: `${v.recipe_name} v${v.version_no}`,
        to: `/versions/${v.version_id}`,
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
