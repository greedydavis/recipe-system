import { useMemo } from 'react';
import { useRpc } from '../data/api';
import type { Dashboard, RecipeListItem } from '../data/types';
import { useCosts } from './costing';
import { currentVersions, summarizeProgress } from './progress';

/** 首頁與進度頁共用。進度、卡關與成本總覽都由現有 RPC 的資料算出來，不需要額外的資料庫查詢 */
export function useProgress() {
  const recipes = useRpc<RecipeListItem[]>('list_recipes', { p_type: null, p_q: null, p_include_archived: false });
  const dashboard = useRpc<Dashboard>('get_dashboard');
  const versionIds = useMemo(() => currentVersions(recipes.data ?? []).map((c) => c.versionId), [recipes.data]);
  const costs = useCosts(versionIds);
  const summary = useMemo(
    () => summarizeProgress(recipes.data ?? [], costs.views, dashboard.data),
    [recipes.data, costs.views, dashboard.data],
  );
  return {
    summary,
    isLoading: recipes.isLoading || dashboard.isLoading,
    costsLoading: costs.isLoading,
    error: recipes.error ?? dashboard.error ?? costs.error,
    hasRecipes: (recipes.data ?? []).length > 0,
  };
}
