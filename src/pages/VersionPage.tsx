import { AlertTriangle, Copy, FileText, GitCompare, Lock, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { can, useRole } from '../app/auth';
import { RequireRole } from '../app/Layout';
import { type CostView, useCosts } from '../app/costing';
import { formatDate, formatDateTime, formatScore, formatSigned, numStr, toNum } from '../app/format';
import { PhotoStrip } from '../components/photos';
import {
  Badge,
  BottomBar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LinkButton,
  Loading,
  Notice,
  NumberInput,
  PageHeader,
  Section,
  Select,
  Sheet,
  StatusBadge,
  Tabs,
  Textarea,
  cx,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type { VersionDetail, VersionLine } from '../data/types';
import {
  altUnitHint,
  formatBatchCost,
  formatLineCost,
  formatNumber,
  formatPercent,
  formatPrice,
  formatQty,
  formatServingCost,
  formatUnitCost,
} from '../domain/format';
import { buildSnapshot } from '../domain/snapshot';
import { type Transition, availableTransitions } from '../domain/status';
import { dec } from '../domain/decimal';
import { DECISION_LABEL, DECISION_TONE, HEAT_LABEL, STATUS_LABEL } from '../i18n/labels';

type TabKey = 'lines' | 'steps' | 'cost' | 'tasting' | 'history';

export function VersionPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <VersionView />
    </RequireRole>
  );
}

function VersionView() {
  const { id = '' } = useParams();
  const role = useRole();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'lines';
  const version = useRpc<VersionDetail>('get_version', { p_id: id });
  const costs = useCosts([id]);
  const [transition, setTransition] = useState<Transition | null>(null);
  const [recordingYield, setRecordingYield] = useState(false);

  const copy = useAction(() => rpc<string>('copy_version', { p_source_id: id, p_change_note: '' }));
  const remove = useAction(() => rpc('delete_draft', { p_version_id: id }));

  const v = version.data;
  if (version.isLoading) return <Loading />;
  if (version.error || !v) return <ErrorState error={version.error} onRetry={() => version.refetch()} />;

  const view = costs.views?.get(id);
  const transitions = availableTransitions(v.status, role);
  const outdated = v.lines.filter((l) => l.component_status === 'retired');

  return (
    <div>
      <PageHeader
        back={`/recipes/${v.recipe.id}`}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {v.recipe.name} v{v.version_no}
            <StatusBadge status={v.status} />
          </span>
        }
        subtitle={
          <>
            {v.title && <span className="mr-2 text-ink">{v.title}</span>}
            {v.based_on_version_no && <span>複製自 v{v.based_on_version_no}・</span>}
            {v.created_by_name} 建立於 {formatDate(v.created_at)}
          </>
        }
      />

      <div className="mb-4 space-y-2">
        {v.status === 'locked' && (
          <Notice tone="ok" title={<span className="inline-flex items-center gap-1"><Lock className="size-4" aria-hidden />已定版，內容不可修改</span>}>
            {formatDate(v.approved_at)} 由 {v.approved_by_name ?? '—'} 核准。要修改請「複製為新版本」。
          </Notice>
        )}
        {(v.status === 'testing' || v.status === 'pending_approval') && (
          <Notice tone="info">
            內容已凍結（{STATUS_LABEL[v.status]}）。要修改請「複製為新版本」。
            {v.status === 'testing' && '試做後量到的產量還是可以記錄。'}
          </Notice>
        )}
        {v.status === 'testing' && can.editRecipes(role) && (v.batch_output_qty === null || v.serving_qty === null) && (
          <Notice tone="warn" title="還沒記錄實際產量">
            <p>試做完秤出成品量再填，系統才算得出出成率與每份成本；送核准前必須填。</p>
            <Button small className="mt-2" onClick={() => setRecordingYield(true)}>
              記錄實際產量
            </Button>
          </Notice>
        )}
        {v.status === 'retired' && (
          <Notice tone="neutral" title="此版本已停用">
            {v.superseded_by_version_no ? (
              <>
                已被 <Link className="text-brand-700 underline" to={`/versions/${v.superseded_by_version_id}`}>v{v.superseded_by_version_no}</Link> 取代。
              </>
            ) : (
              v.retire_reason
            )}
          </Notice>
        )}
        {outdated.length > 0 && (
          <Notice tone="warn" title="引用的元件版本已被取代">
            {outdated.map((l) => `${l.component_name} v${l.component_version_no}（現行 v${l.component_locked_version_no ?? '—'}）`).join('、')}
            。{v.status === 'draft' ? '可以在編輯草案時更換成現行版本。' : '要更新請建立新版本。'}
          </Notice>
        )}
      </div>

      <Summary v={v} view={view} />

      <Tabs<TabKey>
        tabs={[
          { key: 'lines', label: `用料 ${v.lines.length}` },
          { key: 'steps', label: `步驟 ${v.steps.length}` },
          { key: 'cost', label: '成本' },
          { key: 'tasting', label: `試菜 ${v.tastings.length}` },
          { key: 'history', label: '紀錄' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
      />

      {tab === 'lines' && <LinesTab v={v} />}
      {tab === 'steps' && <StepsTab v={v} />}
      {tab === 'cost' && <CostTab v={v} view={view} loading={costs.isLoading} error={costs.error} />}
      {tab === 'tasting' && <TastingTab v={v} />}
      {tab === 'history' && <HistoryTab v={v} canAudit={can.viewAudit(role)} />}

      <Section title="其他操作" className="mt-8">
        <div className="flex flex-wrap gap-2">
          <LinkButton to={`/versions/${id}/card`} small>
            <FileText className="size-4" aria-hidden />
            標準卡／份量換算
          </LinkButton>
          <LinkButton to={`/compare?${v.based_on_version_id ? `a=${v.based_on_version_id}&` : ''}b=${id}`} small>
            <GitCompare className="size-4" aria-hidden />
            版本比較
          </LinkButton>
          {v.status === 'testing' && can.editRecipes(role) && (
            <Button small variant="secondary" onClick={() => setRecordingYield(true)}>
              記錄實際產量
            </Button>
          )}
          {can.editRecipes(role) && (
            <Button
              small
              variant="secondary"
              loading={copy.isPending}
              onClick={() =>
                copy.mutate(undefined, {
                  onSuccess: (newId) => {
                    toast('已複製為新草案');
                    navigate(`/versions/${newId}/edit`);
                  },
                  onError: (e) => toast(e.message, 'danger'),
                })
              }
            >
              <Copy className="size-4" aria-hidden />
              複製為新版本
            </Button>
          )}
          {v.status === 'draft' && can.editRecipes(role) && (
            <Button
              small
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (!confirm(`確定刪除 v${v.version_no} 草案？刪除後版本號不會再使用。`)) return;
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast('已刪除草案');
                    navigate(`/recipes/${v.recipe.id}`);
                  },
                  onError: (e) => toast(e.message, 'danger'),
                });
              }}
            >
              <Trash2 className="size-4" aria-hidden />
              刪除草案
            </Button>
          )}
        </div>
      </Section>

      {(transitions.length > 0 || (v.status === 'draft' && can.editRecipes(role))) && (
        <BottomBar>
          {v.status === 'draft' && can.editRecipes(role) && (
            <LinkButton to={`/versions/${id}/edit`} variant="primary" className="flex-1">
              <Pencil className="size-4" aria-hidden />
              編輯草案
            </LinkButton>
          )}
          {transitions.map((t) => (
            <Button
              key={t.to}
              variant={t.tone === 'danger' ? 'danger' : v.status === 'draft' || t.tone !== 'primary' ? 'secondary' : 'primary'}
              className={t.tone === 'primary' && v.status !== 'draft' ? 'flex-1' : undefined}
              onClick={() => setTransition(t)}
            >
              {t.label}
            </Button>
          ))}
        </BottomBar>
      )}

      {transition && <TransitionSheet v={v} transition={transition} view={view} asOf={costs.bundle?.as_of} onClose={() => setTransition(null)} />}
      {recordingYield && <YieldSheet v={v} onClose={() => setRecordingYield(false)} />}
    </div>
  );
}

function Summary({ v, view }: { v: VersionDetail; view?: CostView }) {
  const isDish = v.recipe.type === 'dish';
  const items: Array<[string, string]> = isDish
    ? [
        ['每份克重', v.serving_qty ? `${formatNumber(v.serving_qty)} ${v.serving_unit}` : '未填'],
        ['每份成本', view ? (view.cost.isComplete ? `$${formatServingCost(view.cost.servingCost)}` : '不完整') : '—'],
        ['食材成本率', formatPercent(view?.metrics.foodCostRate ?? null)],
        ['建議售價', view?.metrics.suggestedPrice ? `$${formatPrice(view.metrics.suggestedPrice)}` : '—'],
      ]
    : [
        ['批次產量', v.batch_output_qty ? `${formatNumber(v.batch_output_qty)} ${v.batch_output_unit}` : '未填'],
        ['每份量', v.serving_qty ? `${formatNumber(v.serving_qty)} ${v.serving_unit}` : '未填'],
        ['出成率', formatPercent(view?.cost.yieldRate ?? null)],
        ['每份成本', view ? (view.cost.isComplete ? `$${formatServingCost(view.cost.servingCost)}` : '不完整') : '—'],
      ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <Card key={label} className="py-3">
          <div className="text-xs text-muted">{label}</div>
          <div className="font-semibold tabular-nums">{value}</div>
        </Card>
      ))}
    </div>
  );
}

function groupLines(lines: VersionLine[]): Array<[string, VersionLine[]]> {
  const groups: Array<[string, VersionLine[]]> = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && last[0] === l.group_label) last[1].push(l);
    else groups.push([l.group_label, [l]]);
  }
  return groups;
}

function LinesTab({ v }: { v: VersionDetail }) {
  if (v.lines.length === 0) return <EmptyState title="還沒有用料" />;
  return (
    <div className="space-y-4">
      {groupLines(v.lines).map(([group, lines], gi) => (
        <div key={`${group}-${gi}`}>
          {group && <h3 className="mb-1 text-sm font-semibold text-muted">{group}</h3>}
          <Card className="divide-y divide-line py-0">
            {lines.map((l) => (
              <div key={l.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {l.line_kind === 'ingredient' ? (
                      <Link to={`/ingredients/${l.ingredient_id}`} className="hover:underline">
                        {l.ingredient_name}
                      </Link>
                    ) : (
                      <Link to={`/versions/${l.component_version_id}`} className="hover:underline">
                        {l.component_name} v{l.component_version_no}
                      </Link>
                    )}
                    {l.line_kind === 'component' && l.component_status && (
                      <StatusBadge status={l.component_status} className="ml-2 align-middle" />
                    )}
                  </div>
                  {(l.prep_note || l.waste_rate_override !== null) && (
                    <div className="text-sm text-muted">
                      {l.prep_note}
                      {l.waste_rate_override !== null && `${l.prep_note ? '・' : ''}損耗 ${formatPercent(dec(l.waste_rate_override))}`}
                    </div>
                  )}
                </div>
                <div className="text-right tabular-nums">
                  {l.quantity === null ? (
                    <Badge tone="warn">用量待填</Badge>
                  ) : (
                    <span className="font-semibold">
                      {formatQty(dec(l.quantity), l.unit)} {l.unit === 'pc' ? '個' : l.unit}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </Card>
        </div>
      ))}
      {v.notes && (
        <Section title="備註">
          <Card className="text-sm whitespace-pre-wrap">{v.notes}</Card>
        </Section>
      )}
    </div>
  );
}

function StepsTab({ v }: { v: VersionDetail }) {
  const role = useRole();
  const editable = v.status === 'draft' && can.editRecipes(role);
  return (
    <div className="space-y-4">
      <Section title="成品照">
        <PhotoStrip photos={v.photos} target={{ version_id: v.id }} canAdd={editable} canDelete={editable} large />
      </Section>
      {v.steps.length === 0 ? (
        <EmptyState title="還沒有製作步驟" />
      ) : (
        <ol className="space-y-2">
          {v.steps.map((s) => (
            <li key={s.id}>
              <Card className={cx(s.is_critical && 'ring-2 ring-red-300')}>
                <div className="flex gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700">
                    {s.step_no}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="whitespace-pre-wrap">{s.instruction || '（未填寫說明）'}</p>
                    <div className="flex flex-wrap gap-2 text-sm">
                      {s.duration_minutes !== null && <Badge>{formatNumber(s.duration_minutes, 1)} 分鐘</Badge>}
                      {s.temperature_c !== null && <Badge>{formatNumber(s.temperature_c, 1)}°C</Badge>}
                      {s.heat_level && <Badge>{HEAT_LABEL[s.heat_level]}</Badge>}
                      {s.is_critical && <Badge tone="danger">關鍵管制點{s.critical_note && `：${s.critical_note}`}</Badge>}
                    </div>
                    {(s.photos.length > 0 || editable) && (
                      <PhotoStrip photos={s.photos} target={{ step_id: s.id }} canAdd={editable} canDelete={editable} />
                    )}
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      )}
      <Card className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-muted">前置時間</div>
          <div>{v.prep_minutes !== null ? `${formatNumber(v.prep_minutes, 1)} 分鐘` : '—'}</div>
        </div>
        <div>
          <div className="text-muted">烹調時間</div>
          <div>{v.cook_minutes !== null ? `${formatNumber(v.cook_minutes, 1)} 分鐘` : '—'}</div>
        </div>
        <div className="col-span-2">
          <div className="text-muted">保存方式與期限</div>
          <div>
            {v.storage_method || '—'}
            {v.shelf_life_hours ? `（${v.shelf_life_hours} 小時內用畢）` : ''}
          </div>
        </div>
      </Card>
    </div>
  );
}

function CostTab({ v, view, loading, error }: { v: VersionDetail; view?: CostView; loading: boolean; error: Error | null }) {
  const role = useRole();
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  if (!view) return null;
  const { cost, metrics } = view;
  const isDish = v.recipe.type === 'dish';
  return (
    <div className="space-y-4">
      {!cost.isComplete && (
        <Notice tone="warn" title="成本不完整">
          <ul className="list-disc pl-5">
            {cost.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          <p className="mt-1">已知部分合計 ${formatLineCost(cost.knownCost)}；補齊後才會計算每份成本、毛利與建議售價。</p>
        </Notice>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="bg-brand-50 text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">用料</th>
              <th className="px-3 py-2 text-right font-medium">淨用量</th>
              <th className="px-3 py-2 text-right font-medium">損耗</th>
              <th className="px-3 py-2 text-right font-medium">採購量</th>
              <th className="px-3 py-2 text-right font-medium">單位成本</th>
              <th className="px-3 py-2 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line tabular-nums">
            {cost.lines.map((l) => (
              <tr key={l.lineId} className={cx(l.issues.length > 0 && 'bg-amber-50')}>
                <td className="px-3 py-2">
                  {l.name}
                  {l.issues.length > 0 && <div className="text-xs text-amber-800">{l.issues.join('；')}</div>}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatQty(l.quantity, l.unit)} {l.unit === 'pc' ? '個' : l.unit}
                </td>
                <td className="px-3 py-2 text-right">{l.kind === 'ingredient' ? formatPercent(l.wasteRate) : '—'}</td>
                <td className="px-3 py-2 text-right">
                  {formatQty(l.purchaseQty, l.baseUnit)} {l.baseUnit === 'pc' ? '個' : l.baseUnit}
                </td>
                <td className="px-3 py-2 text-right">{formatUnitCost(l.unitCost)}</td>
                <td className="px-3 py-2 text-right font-medium">{formatLineCost(l.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <Metric label={isDish ? '每份成本' : '批次成本'} value={isDish ? `$${formatServingCost(cost.servingCost)}` : `$${formatBatchCost(cost.batchCost)}`} strong />
        {!isDish && (
          <>
            <Metric
              label="投入淨重"
              value={cost.inputWeightG ? `${formatQty(cost.inputWeightG, 'g')} g` : '無法計算'}
            />
            <Metric label="出成率" value={formatPercent(cost.yieldRate)} />
            <Metric label="每份成本" value={`$${formatServingCost(cost.servingCost)}`} strong />
            <Metric label="每批份數" value={cost.servingsPerBatch ? formatNumber(cost.servingsPerBatch, 1) : '—'} />
            <Metric
              label={`每${cost.outputUnit === 'ml' ? '公升' : '公斤'}成本`}
              value={cost.costPerOutputUnit ? `$${formatLineCost(cost.costPerOutputUnit.mul(1000))}` : '—'}
            />
          </>
        )}
        {isDish && (
          <>
            <Metric label="含稅售價" value={metrics.menuPrice ? `$${formatPrice(metrics.menuPrice)}` : '未設定'} />
            <Metric label="未稅售價" value={metrics.netPrice ? `$${formatLineCost(metrics.netPrice)}` : '—'} />
            <Metric
              label="食材成本率"
              value={formatPercent(metrics.foodCostRate)}
              strong
              warn={metrics.overTarget}
            />
            <Metric label="食材毛利率" value={formatPercent(metrics.grossMarginRate)} />
            <Metric
              label={`建議售價（目標 ${formatPercent(metrics.targetRate)}）`}
              value={metrics.suggestedPrice ? `$${formatPrice(metrics.suggestedPrice)}` : '—'}
            />
          </>
        )}
      </Card>
      <p className="text-xs text-muted">
        成本以今天有效的單價即時計算；毛利只計算食材，不含人工、能源與租金。
        {role === 'manager' && ' 店長為唯讀。'}
      </p>

      {v.snapshots.length > 0 && (
        <Section title="定版時成本快照">
          {v.snapshots.map((s) => (
            <Card key={s.id} className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Metric label="價格日期" value={formatDate(s.price_as_of)} />
              <Metric label="每份成本" value={s.cost_per_serving !== null ? `$${formatServingCost(dec(s.cost_per_serving))}` : '—'} />
              <Metric label="食材成本率" value={s.food_cost_rate !== null ? formatPercent(dec(s.food_cost_rate)) : '—'} />
              <Metric label="出成率" value={s.yield_rate !== null ? formatPercent(dec(s.yield_rate)) : '—'} />
            </Card>
          ))}
        </Section>
      )}
    </div>
  );
}

function Metric({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={cx('tabular-nums', strong && 'text-lg font-semibold', warn && 'text-red-700')}>
        {value}
        {warn && <AlertTriangle className="ml-1 inline size-4" aria-label="超過目標" />}
      </div>
    </div>
  );
}

function TastingTab({ v }: { v: VersionDetail }) {
  if (v.tastings.length === 0) {
    return (
      <EmptyState title="還沒有試菜紀錄">
        {v.status === 'draft' ? '送試菜後，可以在「試菜」建立場次。' : '到「試菜」建立場次並選擇這個版本。'}
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {v.tastings.map((t) => (
        <Link key={t.item_id} to={`/tastings/${t.session_id}`} className="block">
          <Card className="space-y-2 hover:bg-brand-50">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{formatDate(t.tasted_on)}</span>
              <span className="text-muted">{t.session_title}</span>
              {t.blind_label && <Badge>盲測 {t.blind_label}</Badge>}
              {t.decision && <Badge tone={DECISION_TONE[t.decision]}>{DECISION_LABEL[t.decision]}</Badge>}
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <span>
                整體 <b className="tabular-nums">{formatScore(t.avg_overall)}</b>（{t.feedback_count} 人）
              </span>
              <span>鹹淡 {formatSigned(t.avg_saltiness)}</span>
              <span>油膩 {formatSigned(t.avg_oiliness)}</span>
              {t.maker_name && <span className="text-muted">試做：{t.maker_name}</span>}
            </div>
            {t.deviation_note && <p className="text-sm text-muted">實際偏差：{t.deviation_note}</p>}
            {t.issues.length > 0 && (
              <div className="text-sm">
                <span className="font-medium">問題：</span>
                {t.issues.join('／')}
              </div>
            )}
            {t.suggestions.length > 0 && (
              <div className="text-sm">
                <span className="font-medium">建議：</span>
                {t.suggestions.join('／')}
              </div>
            )}
            {t.conclusion && (
              <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm">
                <span className="font-medium">會議結論：</span>
                {t.conclusion}
              </div>
            )}
            {t.session_summary && (
              <details className="text-sm">
                <summary className="min-h-9 cursor-pointer text-brand-700">當天的試菜總結</summary>
                <p className="mt-1 whitespace-pre-wrap text-muted">{t.session_summary}</p>
              </details>
            )}
          </Card>
        </Link>
      ))}
    </div>
  );
}

function HistoryTab({ v, canAudit }: { v: VersionDetail; canAudit: boolean }) {
  return (
    <div className="space-y-3">
      {v.change_note && (
        <Card>
          <div className="text-sm text-muted">修改說明</div>
          <p className="whitespace-pre-wrap">{v.change_note}</p>
        </Card>
      )}
      <ol className="space-y-2">
        {v.history.map((h) => (
          <li key={h.id}>
            <Card className="py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {h.from_status && <StatusBadge status={h.from_status} />}
                {h.from_status && <span aria-hidden>→</span>}
                <StatusBadge status={h.to_status} />
                <span className="text-muted">
                  {h.actor_name ?? '系統'}・{formatDateTime(h.created_at)}
                </span>
              </div>
              {h.comment && <p className="mt-1 whitespace-pre-wrap">{h.comment}</p>}
            </Card>
          </li>
        ))}
      </ol>
      {canAudit && (
        <LinkButton to={`/audit?table=recipe_versions&record=${v.id}`} small>
          查看完整操作紀錄
        </LinkButton>
      )}
    </div>
  );
}

/** 試菜中記錄實際做出來的產量；食譜內容仍然是凍結的 */
function YieldSheet({ v, onClose }: { v: VersionDetail; onClose: () => void }) {
  const toast = useToast();
  const isDish = v.recipe.type === 'dish';
  const [batchQty, setBatchQty] = useState(numStr(v.batch_output_qty));
  const [batchUnit, setBatchUnit] = useState<'g' | 'ml'>(v.batch_output_unit ?? 'g');
  const [servingQty, setServingQty] = useState(numStr(v.serving_qty));
  const [servingUnit, setServingUnit] = useState<'g' | 'ml'>(v.serving_unit ?? 'g');
  const [density, setDensity] = useState(numStr(v.output_density_g_per_ml));

  const save = useAction(() =>
    rpc('record_yield', {
      p_version_id: v.id,
      p: {
        batch_output_qty: toNum(batchQty) ?? '',
        batch_output_unit: batchUnit,
        serving_qty: toNum(servingQty) ?? '',
        serving_unit: servingUnit,
        output_density_g_per_ml: toNum(density) ?? '',
      },
    }),
  );

  const qtyField = (
    label: string,
    hint: string,
    value: string,
    setValue: (v: string) => void,
    unit: 'g' | 'ml',
    setUnit: (u: 'g' | 'ml') => void,
  ) => (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex gap-2">
          <NumberInput id={id} value={value} onChange={setValue} className="flex-1" />
          <Select aria-label={`${label}單位`} value={unit} onChange={(e) => setUnit(e.target.value as 'g' | 'ml')} className="w-24">
            <option value="g">g</option>
            <option value="ml">ml</option>
          </Select>
        </div>
      )}
    </Field>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={`記錄實際產量：${v.recipe.name} v${v.version_no}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            block
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => {
                  toast('已記錄實際產量');
                  onClose();
                },
                onError: (e) => toast(e.message, 'danger'),
              })
            }
          >
            儲存
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        產量是試做後量出來的結果，所以「試菜中」還可以記錄。用料、步驟等食譜內容仍然凍結，要改請複製為新版本。
      </p>
      {!isDish && qtyField('批次產量', '實際過濾或完成後秤到的量', batchQty, setBatchQty, batchUnit, setBatchUnit)}
      {qtyField(
        isDish ? '每份克重' : '每份量',
        isDish ? '出餐時整份秤重' : '一碗或一份實際舀多少',
        servingQty,
        setServingQty,
        servingUnit,
        setServingUnit,
      )}
      <Field label="成品密度 g/ml（選填）" hint="產量用 ml 記錄、但要算出成率時需要；湯底約 1.0">
        {(id) => <NumberInput id={id} value={density} onChange={setDensity} />}
      </Field>
    </Sheet>
  );
}

function TransitionSheet({
  v,
  transition,
  view,
  asOf,
  onClose,
}: {
  v: VersionDetail;
  transition: Transition;
  view?: CostView;
  asOf?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const needsSnapshot = transition.to === 'locked';
  const hints = useMemo(() => {
    const list: string[] = [];
    if (transition.to === 'testing' || transition.to === 'pending_approval' || transition.to === 'locked') {
      if (v.lines.some((l) => l.quantity === null)) list.push('有用料的用量待填');
      if (v.lines.length === 0) list.push('還沒有用料');
    }
    if ((transition.to === 'pending_approval' || transition.to === 'locked') && view && !view.cost.isComplete) {
      list.push(...view.cost.issues);
    }
    if (transition.to === 'locked') {
      for (const l of v.lines) {
        if (l.line_kind === 'component' && l.component_status !== 'locked') {
          list.push(`「${l.component_name}」v${l.component_version_no} 尚未定版`);
        }
      }
    }
    return [...new Set(list)];
  }, [transition, v, view]);

  const run = useAction(() => {
    const snapshot = needsSnapshot && view && asOf ? buildSnapshot(view.cost, view.metrics, asOf) : null;
    return rpc('transition_version', { p_version_id: v.id, p_to: transition.to, p_comment: comment, p_snapshot: snapshot });
  });

  return (
    <Sheet
      open
      onClose={onClose}
      title={`${transition.label}：${v.recipe.name} v${v.version_no}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            block
            variant={transition.tone === 'danger' ? 'danger' : 'primary'}
            loading={run.isPending}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: () => {
                  toast(`已${transition.label}`);
                  onClose();
                },
                onError: (e) => toast(e.message, 'danger'),
              })
            }
          >
            確認{transition.label}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 text-sm">
        <StatusBadge status={transition.from} />
        <span aria-hidden>→</span>
        <StatusBadge status={transition.to} />
      </div>
      {transition.to === 'testing' && <p className="text-sm text-muted">送試菜後內容會凍結；之後要修改只能複製為新版本。</p>}
      {transition.to === 'locked' && (
        <p className="text-sm text-muted">定版後內容永久不可修改，同一食譜舊的定版會自動停用，並保存今天的成本快照。</p>
      )}
      {hints.length > 0 && (
        <Notice tone="warn" title="可能無法通過">
          <ul className="list-disc pl-5">
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Notice>
      )}
      {transition.commentLabel && (
        <Field label={transition.commentLabel}>
          {(id) => <Textarea id={id} value={comment} onChange={(e) => setComment(e.target.value)} rows={4} />}
        </Field>
      )}
      {view && transition.to === 'locked' && view.cost.isComplete && (
        <p className="text-sm">
          定版成本：每份 ${formatServingCost(view.cost.servingCost)}
          {view.metrics.foodCostRate && `、食材成本率 ${formatPercent(view.metrics.foodCostRate)}`}
          {view.cost.batchOutputQty && view.cost.outputUnit && ` ${altUnitHint(view.cost.batchOutputQty, view.cost.outputUnit) ?? ''}`}
        </p>
      )}
    </Sheet>
  );
}
