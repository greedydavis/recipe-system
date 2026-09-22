import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useCosts } from '../app/costing';
import { useProgress } from './ProgressPage';
import { formatDate, formatDateTime } from '../app/format';
import { useMe } from '../app/auth';
import { Badge, Card, EmptyState, ErrorState, Loading, Section, StatusBadge } from '../components/ui';
import { useRpc } from '../data/api';
import type { Dashboard, MyTastingTask } from '../data/types';
import { formatPercent } from '../domain/format';
import { ROLE_LABEL } from '../i18n/labels';

export function HomePage() {
  const me = useMe();
  const dash = useRpc<Dashboard>('get_dashboard');
  const tasks = useRpc<MyTastingTask[]>('get_my_tasting_tasks');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">你好，{me.display_name}</h1>
        <p className="text-sm text-muted">{ROLE_LABEL[me.role]}</p>
      </header>

      {dash.isLoading && <Loading />}
      {dash.error && <ErrorState error={dash.error} onRetry={() => dash.refetch()} />}

      <MyTasks tasks={tasks.data} loading={tasks.isLoading} />

      {dash.data && me.role !== 'tester' && <KitchenDashboard data={dash.data} />}
    </div>
  );
}

function MyTasks({ tasks, loading }: { tasks?: MyTastingTask[]; loading: boolean }) {
  const open = (tasks ?? []).filter((t) => !t.my_feedback && t.can_submit);
  const done = (tasks ?? []).filter((t) => t.my_feedback);
  if (loading) return null;
  if (!tasks || tasks.length === 0) return null;
  return (
    <Section title={`我的試吃評分（待填 ${open.length}）`}>
      <div className="space-y-2">
        {[...open, ...done].slice(0, 8).map((t) => (
          <Link key={t.item_id} to={`/tasting-items/${t.item_id}/feedback`} className="block">
            <Card className="flex items-center gap-3 hover:bg-brand-50">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{t.display_name}</div>
                <div className="text-sm text-muted">
                  {formatDate(t.tasted_on)}・{t.session_title || '試菜'}
                </div>
              </div>
              {t.my_feedback ? <Badge tone="ok">已評 {t.my_feedback.score_overall} 分</Badge> : <Badge tone="warn">待評分</Badge>}
              <ChevronRight className="size-5 text-stone-400" aria-hidden />
            </Card>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function ProgressCard() {
  const { summary, isLoading } = useProgress();
  if (isLoading || summary.dishes.total === 0) return null;
  const pct = Math.round((summary.dishes.locked / summary.dishes.total) * 100);
  return (
    <Link to="/progress" className="block">
      <Card className="hover:bg-brand-50">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">籌備進度</div>
            <div className="text-sm text-muted">
              菜品 {summary.dishes.locked}／{summary.dishes.total} 已定版・元件 {summary.components.locked}／
              {summary.components.total}・卡關 {summary.blockerCount} 項
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <ChevronRight className="size-5 shrink-0 text-stone-400" aria-hidden />
        </div>
      </Card>
    </Link>
  );
}

function KitchenDashboard({ data }: { data: Dashboard }) {
  const dishIds = (data.dish_cost_versions ?? []).map((d) => d.version_id);
  const costs = useCosts(dishIds);
  const overTarget = (data.dish_cost_versions ?? [])
    .map((d) => ({ ...d, view: costs.views?.get(d.version_id) }))
    .filter((d) => d.view?.metrics.overTarget);
  const incompleteCount = (data.dish_cost_versions ?? []).filter((d) => costs.views?.get(d.version_id)?.cost.isComplete === false).length;

  return (
    <div className="space-y-6">
      <ProgressCard />
      <div className="grid grid-cols-3 gap-2">
        <Stat label="待核准" value={data.pending_approvals?.length ?? 0} to="#pending" />
        <Stat label="試菜中" value={data.testing_versions?.length ?? 0} to="#testing" />
        <Stat label="草案" value={data.draft_count ?? 0} to="/recipes" />
      </div>

      <Section title="待核准" className="scroll-mt-4">
        <div id="pending" />
        {(data.pending_approvals ?? []).length === 0 ? (
          <EmptyState title="目前沒有待核准的版本" />
        ) : (
          <div className="space-y-2">
            {data.pending_approvals!.map((v) => (
              <VersionRow
                key={v.version_id}
                to={`/versions/${v.version_id}`}
                title={`${v.recipe_name} v${v.version_no}`}
                subtitle={`${v.submitted_by_name ?? ''} 於 ${formatDateTime(v.submitted_at)} 送審`}
                badge={<StatusBadge status="pending_approval" />}
              />
            ))}
          </div>
        )}
      </Section>

      {(overTarget.length > 0 || (data.missing_price_ingredients ?? []).length > 0 || (data.outdated_references ?? []).length > 0) && (
        <Section title="需要注意">
          <div className="space-y-2">
            {overTarget.map((d) => (
              <Alert key={d.version_id} to={`/versions/${d.version_id}?tab=cost`}>
                {d.recipe_name} v{d.version_no} 食材成本率 {formatPercent(d.view!.metrics.foodCostRate)}，超過目標{' '}
                {formatPercent(d.view!.metrics.targetRate)}
              </Alert>
            ))}
            {(data.outdated_references ?? []).map((r) => (
              <Alert key={`${r.version_id}-${r.component_name}`} to={`/versions/${r.version_id}`}>
                {r.recipe_name} v{r.version_no} 引用的「{r.component_name}」v{r.component_version_no} 已被取代
                {r.component_locked_version_no ? `（現行 v${r.component_locked_version_no}）` : ''}
              </Alert>
            ))}
            {(data.missing_price_ingredients ?? []).length > 0 && (
              <Alert to="/ingredients?missing=1">
                {data.missing_price_ingredients!.length} 項原物料沒有有效單價：
                {data.missing_price_ingredients!.slice(0, 6).map((i) => i.name).join('、')}
                {data.missing_price_ingredients!.length > 6 ? '…' : ''}
              </Alert>
            )}
          </div>
        </Section>
      )}

      {incompleteCount > 0 && (
        <p className="text-sm text-muted">另有 {incompleteCount} 道菜品成本不完整（缺用量、單價或單位換算），無法判斷是否超過目標成本率。</p>
      )}

      <Section title="試菜中">
        <div id="testing" />
        {(data.testing_versions ?? []).length === 0 ? (
          <EmptyState title="目前沒有試菜中的版本" />
        ) : (
          <div className="space-y-2">
            {data.testing_versions!.map((v) => (
              <VersionRow
                key={v.version_id}
                to={`/versions/${v.version_id}`}
                title={`${v.recipe_name} v${v.version_no}`}
                subtitle={`${v.feedback_count} 筆評分${v.title ? `・${v.title}` : ''}`}
                badge={<StatusBadge status="testing" />}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="最近更新">
        <div className="space-y-2">
          {(data.recent_versions ?? []).map((v) => (
            <VersionRow
              key={v.version_id}
              to={`/versions/${v.version_id}`}
              title={`${v.recipe_name} v${v.version_no}`}
              subtitle={formatDateTime(v.updated_at)}
              badge={<StatusBadge status={v.status} />}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value, to }: { label: string; value: number; to: string }) {
  const body = (
    <Card className="text-center hover:bg-brand-50">
      <div className="text-2xl font-bold text-brand-700 tabular-nums">{value}</div>
      <div className="text-sm text-muted">{label}</div>
    </Card>
  );
  return to.startsWith('#') ? <a href={to}>{body}</a> : <Link to={to}>{body}</Link>;
}

function VersionRow({ to, title, subtitle, badge }: { to: string; title: string; subtitle: string; badge: ReactNode }) {
  return (
    <Link to={to} className="block">
      <Card className="flex items-center gap-3 py-3 hover:bg-brand-50">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{title}</div>
          <div className="truncate text-sm text-muted">{subtitle}</div>
        </div>
        {badge}
        <ChevronRight className="size-5 text-stone-400" aria-hidden />
      </Card>
    </Link>
  );
}

function Alert({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </Link>
  );
}
