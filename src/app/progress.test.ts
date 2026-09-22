import { describe, expect, it } from 'vitest';
import type { CostView } from './costing';
import { summarizeProgress } from './progress';
import type { Dashboard, RecipeListItem } from '../data/types';
import { computeVersionCost } from '../domain/costing';
import { priceMetrics } from '../domain/pricing';
import { DEFAULT_SETTINGS, bundle, ingLine, ingredient, version } from '../domain/__fixtures__/builders';

function recipe(over: Partial<RecipeListItem> & { id: string; name: string }): RecipeListItem {
  return {
    code: 'D-001',
    type: 'dish',
    component_kind: null,
    menu_category: '湯麵',
    description: '',
    is_archived: false,
    target_food_cost_rate: null,
    current_price: null,
    locked: null,
    latest: { id: `${over.id}-v1`, version_no: 1, title: '', status: 'draft', updated_at: '2026-09-22' },
    version_count: 1,
    has_outdated_components: false,
    updated_at: '2026-09-22',
    ...over,
  };
}

/** 用真的計算核心產生成本，避免測試自己編造數字 */
function viewFor(opts: { price?: number; quantity?: number | null; batch?: [number, 'g'] | null }): CostView {
  const salt = ingredient({ name: '鹽', base: 'mass', spec: { qty: 1, unit: 'kg', price: 30 } });
  const v = version({
    name: '測試菜',
    type: 'dish',
    serving: opts.batch === null ? null : [600, 'g'],
    menuPrice: opts.price ?? null,
    lines: [ingLine(salt, opts.quantity === undefined ? 100 : opts.quantity, 'g')],
  });
  const b = bundle([v], [salt]);
  const cost = computeVersionCost(b, v.id);
  return { cost, metrics: priceMetrics(cost.servingCost, v, DEFAULT_SETTINGS) };
}

describe('籌備進度彙整', () => {
  const recipes: RecipeListItem[] = [
    recipe({ id: 'a', name: '定版菜', locked: { id: 'a-v2', version_no: 2, title: '', approved_at: '2026-09-20' }, current_price: { id: 'p', price: 100, effective_date: '2026-09-01' } }),
    recipe({ id: 'b', name: '試菜中菜', latest: { id: 'b-v1', version_no: 1, title: '', status: 'testing', updated_at: '2026-09-22' } }),
    recipe({ id: 'c', name: '草案菜', menu_category: '拌麵' }),
    recipe({ id: 's', name: '湯底', type: 'component', component_kind: 'soup', code: 'C-001', menu_category: '' }),
  ];

  const views = new Map<string, CostView>([
    ['a-v2', viewFor({ price: 100 })],
    ['b-v1', viewFor({ quantity: null })],
    ['c-v1', viewFor({ batch: null })],
    ['s-v1', viewFor({})],
  ]);

  const dashboard = {
    role: 'founder',
    my_open_tasting_tasks: 0,
    missing_price_ingredients: [{ id: 'i1', name: '雞骨架', code: 'I-0001' }],
    testing_versions: [
      { version_id: 'b-v1', recipe_id: 'b', recipe_name: '試菜中菜', recipe_type: 'dish' as const, version_no: 1, title: '', updated_at: '', feedback_count: 0 },
    ],
    outdated_references: [],
    pending_approvals: [],
  } as unknown as Dashboard;

  const summary = summarizeProgress(recipes, views, dashboard);

  it('依分類統計進度，菜品與元件分開算', () => {
    expect(summary.dishes).toEqual({ total: 3, locked: 1 });
    expect(summary.components).toEqual({ total: 1, locked: 0 });
    const soup = summary.categories.find((c) => c.category.startsWith('元件'));
    expect(soup?.total).toBe(1);
    const noodle = summary.categories.find((c) => c.category === '湯麵');
    expect(noodle?.counts).toMatchObject({ locked: 1, testing: 1, draft: 0 });
  });

  it('卡關清單只列出真的有問題的項目', () => {
    const kinds = summary.blockers.map((b) => b.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['missing_price', 'missing_quantity', 'missing_yield', 'not_in_testing', 'no_feedback']),
    );
    expect(kinds).not.toContain('outdated_component');
    expect(kinds).not.toContain('pending_approval');

    const quantity = summary.blockers.find((b) => b.kind === 'missing_quantity')!;
    expect(quantity.items).toEqual([{ id: 'b-v1', label: '試菜中菜 v1', to: '/versions/b-v1' }]);
    const price = summary.blockers.find((b) => b.kind === 'missing_price')!;
    expect(price.items[0]).toMatchObject({ label: '雞骨架', to: '/ingredients/i1' });
    expect(summary.blockerCount).toBe(
      summary.blockers.reduce((n, g) => n + g.items.length, 0),
    );
  });

  it('成本總覽只看菜品，並統計完整與超標數量', () => {
    expect(summary.costRows.map((r) => r.name)).toEqual(['定版菜', '試菜中菜', '草案菜']);
    const locked = summary.costRows[0];
    // 鹽 100 g × 0.03 = 3 元；售價 100 含稅 → 未稅 95.238 → 3.15%
    expect(locked.servingCost?.toString()).toBe('3');
    expect(locked.foodCostRate?.toFixed(4)).toBe('0.0315');
    expect(locked.overTarget).toBe(false);
    expect(summary.costStats).toMatchObject({ complete: 1, incomplete: 2, overTarget: 0, priced: 1 });
    expect(summary.costStats.avgFoodCostRate?.toFixed(4)).toBe('0.0315');
  });
});
