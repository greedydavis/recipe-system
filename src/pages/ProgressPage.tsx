import { AlertTriangle, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useCosts } from '../app/costing';
import { RequireRole } from '../app/Layout';
import { type BlockerGroup, type CategoryProgress, type CostRow, currentVersions, summarizeProgress } from '../app/progress';
import { Badge, Card, ErrorState, Loading, Notice, PageHeader, Section, StatusBadge, cx } from '../components/ui';
import { useRpc } from '../data/api';
import type { Dashboard, RecipeListItem } from '../data/types';
import { formatPercent, formatPrice, formatServingCost } from '../domain/format';
import type { VersionStatus } from '../domain/types';
import { STATUS_LABEL } from '../i18n/labels';

const BAR_COLOR: Record<VersionStatus, string> = {
  locked: 'bg-emerald-500',
  pending_approval: 'bg-sky-500',
  testing: 'bg-amber-400',
  draft: 'bg-stone-300',
  retired: 'bg-zinc-200',
};

const STAGES: VersionStatus[] = ['locked', 'pending_approval', 'testing', 'draft', 'retired'];

export function ProgressPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <Progress />
    </RequireRole>
  );
}

/** 進度、卡關與成本總覽都由現有 RPC 的資料算出來，不需要額外的資料庫查詢 */
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

function Progress() {
  const { summary, isLoading, costsLoading, error, hasRecipes } = useProgress();

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="space-y-6">
      <PageHeader title="籌備進度" subtitle="離「每道菜都有定版標準卡」還差多遠，以及卡在哪裡" />

      {!hasRecipes && <Notice tone="info">還沒有菜品；先到「食譜」新增，或到「更多 → 資料匯出與匯入」匯入基準版菜單。</Notice>}

      <div className="grid grid-cols-2 gap-2">
        <Card className="py-3">
          <div className="text-xs text-muted">菜品已定版</div>
          <div className="text-2xl font-bold tabular-nums text-brand-700">
            {summary.dishes.locked}
            <span className="text-base font-medium text-muted"> / {summary.dishes.total}</span>
          </div>
        </Card>
        <Card className="py-3">
          <div className="text-xs text-muted">元件已定版</div>
          <div className="text-2xl font-bold tabular-nums text-brand-700">
            {summary.components.locked}
            <span className="text-base font-medium text-muted"> / {summary.components.total}</span>
          </div>
        </Card>
      </div>

      <Section title="各分類進度">
        <div className="space-y-3">
          {summary.categories.map((c) => (
            <CategoryBar key={c.category} progress={c} />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {STAGES.filter((s) => s !== 'retired').map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={cx('inline-block size-2.5 rounded-full', BAR_COLOR[s])} aria-hidden />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
      </Section>

      <Section title={`卡關清單（${summary.blockerCount}）`}>
        {summary.blockers.length === 0 ? (
          <Notice tone="ok">目前沒有卡住的項目。</Notice>
        ) : (
          <div className="space-y-3">
            {summary.blockers.map((g) => (
              <BlockerCard key={g.kind} group={g} />
            ))}
          </div>
        )}
      </Section>

      <Section title="成本與售價">
        {costsLoading ? (
          <Loading label="計算成本中…" />
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-2 text-sm">
              <Badge tone="ok">成本完整 {summary.costStats.complete}</Badge>
              <Badge tone="warn">成本不完整 {summary.costStats.incomplete}</Badge>
              <Badge tone={summary.costStats.overTarget > 0 ? 'danger' : 'neutral'}>超過目標 {summary.costStats.overTarget}</Badge>
              <Badge>已設售價 {summary.costStats.priced}</Badge>
              {summary.costStats.avgFoodCostRate && (
                <Badge tone="info">平均食材成本率 {formatPercent(summary.costStats.avgFoodCostRate)}</Badge>
              )}
            </div>
            <CostTable rows={summary.costRows} />
            <p className="text-xs text-muted">
              平均是已算得出成本的菜品的簡單平均，沒有依銷售佔比加權；要對照財務規劃模型時，請用各菜的成本自行加權。
            </p>
          </>
        )}
      </Section>
    </div>
  );
}

function CategoryBar({ progress }: { progress: CategoryProgress }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{progress.category}</span>
        <span className="text-muted tabular-nums">
          {progress.counts.locked} / {progress.total} 已定版
        </span>
      </div>
      <div className="mt-1 flex h-3 overflow-hidden rounded-full bg-stone-100" role="img" aria-label={`${progress.category} 進度`}>
        {STAGES.map((s) =>
          progress.counts[s] > 0 ? (
            <div
              key={s}
              className={BAR_COLOR[s]}
              style={{ width: `${(progress.counts[s] / progress.total) * 100}%` }}
              title={`${STATUS_LABEL[s]} ${progress.counts[s]}`}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function BlockerCard({ group }: { group: BlockerGroup }) {
  const shown = group.items.slice(0, 8);
  return (
    <Card className="space-y-2 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {group.title}
            <span className="ml-2 text-sm font-normal text-muted">{group.items.length} 項</span>
          </div>
          <p className="text-sm text-muted">{group.hint}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {shown.map((item) => (
          <Link
            key={item.id}
            to={item.to}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-stone-50 px-2.5 text-sm hover:bg-brand-50"
          >
            {item.label}
            <ChevronRight className="size-4 text-stone-400" aria-hidden />
          </Link>
        ))}
        {group.items.length > shown.length && <span className="self-center text-sm text-muted">還有 {group.items.length - shown.length} 項</span>}
      </div>
    </Card>
  );
}

function CostTable({ rows }: { rows: CostRow[] }) {
  if (rows.length === 0) return <Notice tone="info">還沒有菜品。</Notice>;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[32rem] text-sm">
        <thead className="bg-brand-50 text-left text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">菜品</th>
            <th className="px-3 py-2 text-right font-medium">每份成本</th>
            <th className="px-3 py-2 text-right font-medium">售價</th>
            <th className="px-3 py-2 text-right font-medium">食材成本率</th>
            <th className="px-3 py-2 text-right font-medium">建議售價</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line tabular-nums">
          {rows.map((r) => (
            <tr key={r.recipeId} className={cx(r.overTarget && 'bg-red-50')}>
              <td className="px-3 py-2">
                <Link to={`/versions/${r.versionId}?tab=cost`} className="font-medium hover:underline">
                  {r.name}
                </Link>
                <div className="flex items-center gap-1 text-xs text-muted">
                  {r.category}
                  <StatusBadge status={r.stage} />
                </div>
              </td>
              <td className="px-3 py-2 text-right">{r.complete ? `$${formatServingCost(r.servingCost)}` : <span className="text-amber-800">不完整</span>}</td>
              <td className="px-3 py-2 text-right">{r.price !== null ? `$${r.price}` : '—'}</td>
              <td className={cx('px-3 py-2 text-right', r.overTarget && 'font-semibold text-red-700')}>
                {formatPercent(r.foodCostRate)}
                {r.overTarget && r.targetRate && <div className="text-xs font-normal">目標 {formatPercent(r.targetRate)}</div>}
              </td>
              <td className="px-3 py-2 text-right">{r.suggestedPrice ? `$${formatPrice(r.suggestedPrice)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
