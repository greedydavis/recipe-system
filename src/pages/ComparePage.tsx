import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useCosts } from '../app/costing';
import { formatScore, formatSigned } from '../app/format';
import { RequireRole } from '../app/Layout';
import { Badge, Card, EmptyState, ErrorState, Loading, PageHeader, Section, Select, StatusBadge, cx } from '../components/ui';
import { useRpc } from '../data/api';
import type { RecipeDetail, VersionDetail } from '../data/types';
import { dec } from '../domain/decimal';
import { type ChangeKind, diffLines, diffSteps } from '../domain/diff';
import { formatNumber, formatPercent, formatQty, formatServingCost } from '../domain/format';

const CHANGE_STYLE: Record<ChangeKind, string> = {
  added: 'bg-emerald-50',
  removed: 'bg-red-50 line-through decoration-red-400',
  changed: 'bg-amber-50',
  same: '',
};
const CHANGE_LABEL: Record<ChangeKind, string> = { added: '新增', removed: '刪除', changed: '修改', same: '' };

export function ComparePage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <Compare />
    </RequireRole>
  );
}

function Compare() {
  const [params, setParams] = useSearchParams();
  const aId = params.get('a');
  const bId = params.get('b');
  const b = useRpc<VersionDetail>('get_version', { p_id: bId }, { enabled: !!bId });
  const recipe = useRpc<RecipeDetail>('get_recipe', { p_id: b.data?.recipe_id }, { enabled: !!b.data });
  const a = useRpc<VersionDetail>('get_version', { p_id: aId }, { enabled: !!aId });
  const costs = useCosts([aId, bId].filter((x): x is string => !!x));

  const lineDiff = useMemo(() => {
    if (!a.data || !b.data) return [];
    const map = (v: VersionDetail) =>
      v.lines.map((l) => ({
        ...l,
        component_recipe_id: l.component_recipe_id,
      }));
    return diffLines(map(a.data), map(b.data));
  }, [a.data, b.data]);
  const stepDiff = useMemo(() => (a.data && b.data ? diffSteps(a.data.steps, b.data.steps) : []), [a.data, b.data]);

  if (!bId) return <EmptyState title="請從版本頁進入比較" />;
  if (b.isLoading) return <Loading />;
  if (b.error || !b.data) return <ErrorState error={b.error} />;

  const setSide = (side: 'a' | 'b', value: string) => {
    const next = new URLSearchParams(params);
    next.set(side, value);
    setParams(next, { replace: true });
  };
  const versions = recipe.data?.versions ?? [];
  const va = a.data;
  const vb = b.data;
  const ca = aId ? costs.views?.get(aId) : undefined;
  const cb = costs.views?.get(bId);

  const avg = (v?: VersionDetail, key: 'avg_overall' | 'avg_saltiness' | 'avg_oiliness' = 'avg_overall') => {
    if (!v) return null;
    const rows = v.tastings.filter((t) => t[key] !== null && t.feedback_count > 0);
    const total = rows.reduce((s, t) => s + t.feedback_count, 0);
    if (!total) return null;
    return rows.reduce((s, t) => s + Number(t[key]) * t.feedback_count, 0) / total;
  };

  return (
    <div className="space-y-6">
      <PageHeader back={`/versions/${bId}`} title="版本比較" subtitle={vb.recipe.name} />

      <div className="grid grid-cols-2 gap-2">
        {(['a', 'b'] as const).map((side) => (
          <Select key={side} aria-label={side === 'a' ? '比較基準' : '比較對象'} value={(side === 'a' ? aId : bId) ?? ''} onChange={(e) => setSide(side, e.target.value)}>
            {side === 'a' && <option value="">選擇版本</option>}
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_no}（{v.title || v.status}）
              </option>
            ))}
          </Select>
        ))}
      </div>

      {!va ? (
        <EmptyState title="選擇要比較的另一個版本" />
      ) : (
        <>
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm tabular-nums">
              <thead className="bg-brand-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-muted">項目</th>
                  <th className="px-3 py-2 font-medium">
                    v{va.version_no} <StatusBadge status={va.status} />
                  </th>
                  <th className="px-3 py-2 font-medium">
                    v{vb.version_no} <StatusBadge status={vb.status} />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <Row label="每份成本" a={ca?.cost.isComplete ? `$${formatServingCost(ca.cost.servingCost)}` : '不完整'} b={cb?.cost.isComplete ? `$${formatServingCost(cb.cost.servingCost)}` : '不完整'} />
                {vb.recipe.type === 'dish' ? (
                  <Row label="食材成本率" a={formatPercent(ca?.metrics.foodCostRate ?? null)} b={formatPercent(cb?.metrics.foodCostRate ?? null)} />
                ) : (
                  <Row label="出成率" a={formatPercent(ca?.cost.yieldRate ?? null)} b={formatPercent(cb?.cost.yieldRate ?? null)} />
                )}
                <Row label={vb.recipe.type === 'dish' ? '每份克重' : '批次產量'} a={va.batch_output_qty ? `${formatNumber(va.batch_output_qty)} ${va.batch_output_unit}` : '—'} b={vb.batch_output_qty ? `${formatNumber(vb.batch_output_qty)} ${vb.batch_output_unit}` : '—'} />
                <Row label="試吃平均（整體）" a={formatScore(avg(va))} b={formatScore(avg(vb))} />
                <Row label="鹹淡（−2 淡／+2 鹹）" a={formatSigned(avg(va, 'avg_saltiness'))} b={formatSigned(avg(vb, 'avg_saltiness'))} />
                <Row label="油膩（−2 清／+2 油）" a={formatSigned(avg(va, 'avg_oiliness'))} b={formatSigned(avg(vb, 'avg_oiliness'))} />
              </tbody>
            </table>
          </Card>

          <Section title="用料差異">
            <Card className="divide-y divide-line p-0">
              {lineDiff.map((d) => (
                <div key={d.key} className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm', CHANGE_STYLE[d.change])}>
                  <span className="min-w-24 flex-1 font-medium">{d.name}</span>
                  <span className="tabular-nums text-muted">
                    {d.a ? `${d.a.quantity === null ? '待填' : formatQty(dec(d.a.quantity), d.a.unit)} ${d.a.unit}` : '—'}
                  </span>
                  <span aria-hidden>→</span>
                  <span className="font-semibold tabular-nums">
                    {d.b ? `${d.b.quantity === null ? '待填' : formatQty(dec(d.b.quantity), d.b.unit)} ${d.b.unit}` : '—'}
                  </span>
                  {d.qtyRatio && !d.qtyRatio.isZero() && (
                    <span className={cx('tabular-nums', d.qtyRatio.gt(0) ? 'text-emerald-700' : 'text-red-700')}>
                      {d.qtyRatio.gt(0) ? '+' : ''}
                      {formatPercent(d.qtyRatio)}
                    </span>
                  )}
                  {d.change !== 'same' && <Badge tone={d.change === 'added' ? 'ok' : d.change === 'removed' ? 'danger' : 'warn'}>{CHANGE_LABEL[d.change]}{d.changedFields.length ? `：${d.changedFields.join('、')}` : ''}</Badge>}
                </div>
              ))}
            </Card>
          </Section>

          <Section title="步驟差異">
            {stepDiff.length === 0 ? (
              <p className="text-sm text-muted">兩個版本都沒有步驟</p>
            ) : (
              <div className="space-y-2">
                {stepDiff.map((d) => (
                  <Card key={d.stepNo} className={cx('text-sm', CHANGE_STYLE[d.change])}>
                    <div className="flex items-center gap-2 font-medium">
                      步驟 {d.stepNo}
                      {d.change !== 'same' && <Badge tone={d.change === 'added' ? 'ok' : d.change === 'removed' ? 'danger' : 'warn'}>{CHANGE_LABEL[d.change]}{d.changedFields.length ? `：${d.changedFields.join('、')}` : ''}</Badge>}
                    </div>
                    {d.change === 'changed' ? (
                      <div className="mt-1 grid gap-2 sm:grid-cols-2">
                        <p className="text-muted">v{va.version_no}：{d.a?.instruction}</p>
                        <p>v{vb.version_no}：{d.b?.instruction}</p>
                      </div>
                    ) : (
                      <p className="mt-1">{(d.b ?? d.a)?.instruction}</p>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr>
      <td className="px-3 py-2 text-muted">{label}</td>
      <td className="px-3 py-2">{a}</td>
      <td className={cx('px-3 py-2', a !== b && 'font-semibold')}>{b}</td>
    </tr>
  );
}
