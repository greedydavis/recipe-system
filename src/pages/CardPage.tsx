import { Printer } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { can, useRole } from '../app/auth';
import { useCosts } from '../app/costing';
import { formatDate, formatDateTime, toNum } from '../app/format';
import { RequireRole } from '../app/Layout';
import { PhotoThumb } from '../components/photos';
import { Button, Checkbox, ChipGroup, ErrorState, Loading, Notice, NumberInput, PageHeader, Select, StatusBadge, cx } from '../components/ui';
import { useRpc } from '../data/api';
import type { VersionDetail, VersionLine } from '../data/types';
import { dec } from '../domain/decimal';
import {
  altUnitHint,
  formatFactor,
  formatLineCost,
  formatNumber,
  formatPercent,
  formatPrice,
  formatQty,
  formatServingCost,
} from '../domain/format';
import { type ScaleMode, scaleFactor } from '../domain/scaling';
import type { OutputUnit } from '../domain/types';
import { HEAT_LABEL, STATUS_LABEL } from '../i18n/labels';

type Preset = '1' | '10' | 'batch' | 'servings' | 'output';

export function CardPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <StandardCard />
    </RequireRole>
  );
}

function StandardCard() {
  const { id = '' } = useParams();
  const role = useRole();
  const version = useRpc<VersionDetail>('get_version', { p_id: id });
  const costs = useCosts([id], can.viewKitchen(role));
  const [preset, setPreset] = useState<Preset>('1');
  const [customServings, setCustomServings] = useState('20');
  const [customOutput, setCustomOutput] = useState('');
  const [customUnit, setCustomUnit] = useState<OutputUnit>('g');
  const [paper, setPaper] = useState<'A4' | 'A5'>('A4');
  const [withCost, setWithCost] = useState(false);

  const v = version.data;
  const isDish = v?.recipe.type === 'dish';

  const mode: ScaleMode | null = useMemo(() => {
    switch (preset) {
      case '1':
        return { kind: 'servings', servings: 1 };
      case '10':
        return { kind: 'servings', servings: 10 };
      case 'batch':
        return { kind: 'batches', batches: 1 };
      case 'servings':
        return toNum(customServings) ? { kind: 'servings', servings: toNum(customServings)! } : null;
      case 'output':
        return toNum(customOutput) ? { kind: 'output', qty: toNum(customOutput)!, unit: customUnit } : null;
    }
  }, [preset, customServings, customOutput, customUnit]);

  if (version.isLoading) return <Loading />;
  if (version.error || !v) return <ErrorState error={version.error} />;

  const factorResult = mode
    ? scaleFactor(
        {
          recipe_type: v.recipe.type,
          recipe_name: v.recipe.name,
          version_no: v.version_no,
          batch_output_qty: v.batch_output_qty,
          batch_output_unit: v.batch_output_unit,
          serving_qty: v.serving_qty,
          serving_unit: v.serving_unit,
          output_density_g_per_ml: v.output_density_g_per_ml,
        },
        mode,
      )
    : null;
  const factor = factorResult?.ok ? factorResult.value : null;
  const view = costs.views?.get(id);
  const showCost = withCost && can.approve(role);
  const costByLine = new Map(view?.cost.lines.map((l) => [l.lineId, l]) ?? []);
  const outputAtScale = factor && v.batch_output_qty ? dec(v.batch_output_qty).mul(factor) : null;
  const servingsAtScale =
    factor && view?.cost.servingsPerBatch ? view.cost.servingsPerBatch.mul(factor) : isDish && factor ? factor : null;

  const presetLabel =
    preset === '1' ? '1 份' : preset === '10' ? '10 份' : preset === 'batch' ? '1 批次' : preset === 'servings' ? `${customServings} 份` : `產量 ${customOutput} ${customUnit}`;

  return (
    <div>
      <style>{`@page { size: ${paper} portrait; margin: 12mm; }`}</style>
      <PageHeader back={`/versions/${id}`} title="標準卡" subtitle={`${v.recipe.name} v${v.version_no}`} />

      <div className="no-print mb-4 space-y-3">
        <ChipGroup<Preset>
          label="份量"
          value={preset}
          onChange={(p) => p && setPreset(p)}
          options={[
            { value: '1', label: '1 份' },
            { value: '10', label: '10 份' },
            ...(isDish ? [] : [{ value: 'batch' as Preset, label: '1 批次' }]),
            { value: 'servings', label: '自訂份數' },
            ...(isDish ? [] : [{ value: 'output' as Preset, label: '自訂產量' }]),
          ]}
        />
        {preset === 'servings' && (
          <div className="flex items-center gap-2">
            <NumberInput aria-label="份數" value={customServings} onChange={setCustomServings} className="w-32" />
            <span>份</span>
          </div>
        )}
        {preset === 'output' && (
          <div className="flex items-center gap-2">
            <NumberInput aria-label="目標產量" value={customOutput} onChange={setCustomOutput} className="w-40" placeholder="例如 30000" />
            <Select aria-label="單位" value={customUnit} onChange={(e) => setCustomUnit(e.target.value as OutputUnit)} className="w-24">
              <option value="g">g</option>
              <option value="ml">ml</option>
            </Select>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="紙張" value={paper} onChange={(e) => setPaper(e.target.value as 'A4' | 'A5')} className="w-28">
            <option value="A4">A4</option>
            <option value="A5">A5</option>
          </Select>
          {can.approve(role) && <Checkbox checked={withCost} onChange={setWithCost} label="含成本（創辦人）" />}
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden />
            列印
          </Button>
        </div>
        {factorResult && !factorResult.ok && <Notice tone="warn">{factorResult.issue}</Notice>}
      </div>

      <article
        className={cx(
          'print-card relative overflow-hidden rounded-2xl bg-white p-5 ring-1 ring-line',
          paper === 'A5' ? 'text-[13px]' : 'text-[15px]',
        )}
      >
        {v.status !== 'locked' && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-5xl font-black tracking-widest text-red-600/15 select-none"
            style={{ transform: 'rotate(-25deg)' }}
          >
            非定版，不可用於出餐
          </div>
        )}

        <header className="flex items-start justify-between gap-3 border-b-2 border-ink pb-3">
          <div>
            <div className="text-xs text-muted">{v.recipe.code}・{isDish ? v.recipe.menu_category || '菜品' : '元件'}</div>
            <h1 className="text-2xl font-bold">
              {v.recipe.name} <span className="text-brand-700">v{v.version_no}</span>
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={v.status} />
              {v.status === 'locked' ? (
                <span>
                  {formatDate(v.approved_at)} 定版・核准人 {v.approved_by_name ?? '—'}
                </span>
              ) : (
                <span className="font-semibold text-red-700">{STATUS_LABEL[v.status]}，僅供試做參考</span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted">份量</div>
            <div className="text-xl font-bold whitespace-nowrap">{presetLabel}</div>
            <div className="text-xs text-muted">倍率 ×{formatFactor(factor)}</div>
          </div>
        </header>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Info label={isDish ? '每份克重' : '批次產量'} value={v.batch_output_qty ? `${formatNumber(v.batch_output_qty)} ${v.batch_output_unit}` : '—'} />
          {!isDish && <Info label="每份量" value={v.serving_qty ? `${formatNumber(v.serving_qty)} ${v.serving_unit}` : '—'} />}
          <Info
            label="本次產量"
            value={
              outputAtScale && v.batch_output_unit
                ? `${formatQty(outputAtScale, v.batch_output_unit)} ${v.batch_output_unit}${servingsAtScale ? `（約 ${formatNumber(servingsAtScale, 1)} 份）` : ''}`
                : '—'
            }
          />
          {!isDish && <Info label="出成率" value={formatPercent(view?.cost.yieldRate ?? null)} />}
        </div>

        <div className="mt-4 flex gap-4">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ink text-sm">
                <th className="py-1.5 font-semibold">用料</th>
                <th className="py-1.5 text-right font-semibold">用量</th>
                <th className="py-1.5 pl-3 font-semibold">處理方式</th>
                {showCost && <th className="py-1.5 text-right font-semibold">成本</th>}
              </tr>
            </thead>
            <tbody>
              {groupLines(v.lines).map(([group, lines], gi) => (
                <FragmentGroup key={`${group}-${gi}`} group={group} colSpan={showCost ? 4 : 3}>
                  {lines.map((l) => {
                    const scaled = factor && l.quantity !== null ? dec(l.quantity).mul(factor) : null;
                    const lineCost = costByLine.get(l.id)?.cost;
                    return (
                      <tr key={l.id} className="print-avoid-break border-b border-line align-top">
                        <td className="py-1.5">
                          {lineName(l)}
                          {l.component_status === 'retired' && <div className="text-xs font-semibold text-red-700">此元件版本已被取代</div>}
                        </td>
                        <td className="py-1.5 text-right font-semibold whitespace-nowrap tabular-nums">
                          {l.quantity === null ? '待填' : `${formatQty(scaled, l.unit)} ${l.unit === 'pc' ? '個' : l.unit}`}
                          {scaled && altUnitHint(scaled, l.unit) && <div className="text-xs font-normal text-muted">{altUnitHint(scaled, l.unit)}</div>}
                        </td>
                        <td className="py-1.5 pl-3 text-sm">{l.prep_note}</td>
                        {showCost && (
                          <td className="py-1.5 text-right text-sm tabular-nums">
                            {lineCost && factor ? formatLineCost(lineCost.mul(factor)) : '—'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </FragmentGroup>
              ))}
            </tbody>
          </table>
          {v.photos[0] && (
            <div className="hidden w-40 shrink-0 sm:block print:block">
              <PhotoThumb path={v.photos[0].storage_path} alt="成品照" className="aspect-square w-full rounded-lg" />
            </div>
          )}
        </div>

        {v.steps.length > 0 && (
          <section className="mt-4">
            <h2 className="border-b border-ink pb-1 font-semibold">製作步驟</h2>
            <ol className="mt-2 space-y-2">
              {v.steps.map((s) => (
                <li key={s.id} className={cx('print-avoid-break flex gap-2', s.is_critical && 'rounded-lg bg-red-50 p-2 ring-1 ring-red-300')}>
                  <span className="font-bold">{s.step_no}.</span>
                  <div className="flex-1">
                    <div className="whitespace-pre-wrap">{s.instruction}</div>
                    <div className="flex flex-wrap gap-x-3 text-sm text-muted">
                      {s.duration_minutes !== null && <span>⏱ {formatNumber(s.duration_minutes, 1)} 分鐘</span>}
                      {s.temperature_c !== null && <span>🌡 {formatNumber(s.temperature_c, 1)}°C</span>}
                      {s.heat_level && <span>🔥 {HEAT_LABEL[s.heat_level]}</span>}
                      {s.is_critical && <span className="font-semibold text-red-700">關鍵管制點：{s.critical_note}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {(v.storage_method || v.shelf_life_hours) && (
          <section className="mt-4 text-sm">
            <span className="font-semibold">保存：</span>
            {v.storage_method}
            {v.shelf_life_hours ? `；${v.shelf_life_hours} 小時內用畢` : ''}
          </section>
        )}

        {showCost && view && (
          <section className="mt-4 rounded-lg bg-brand-50 p-3 text-sm tabular-nums">
            {view.cost.isComplete ? (
              <>
                本次成本 ${formatLineCost(view.cost.batchCost && factor ? view.cost.batchCost.mul(factor) : null)}・每份 $
                {formatServingCost(view.cost.servingCost)}
                {isDish && view.metrics.foodCostRate && `・食材成本率 ${formatPercent(view.metrics.foodCostRate)}`}
                {isDish && view.metrics.suggestedPrice && `・建議售價 $${formatPrice(view.metrics.suggestedPrice)}`}
              </>
            ) : (
              '成本不完整'
            )}
          </section>
        )}

        <footer className="mt-4 border-t border-line pt-2 text-xs text-muted">
          時間、溫度、火力不隨份量等比例調整，大量製作時請依實際狀況確認。列印時間 {formatDateTime(new Date().toISOString())}
        </footer>
      </article>
    </div>
  );
}

function lineName(l: VersionLine): string {
  return l.line_kind === 'ingredient' ? (l.ingredient_name ?? '') : `${l.component_name} v${l.component_version_no}`;
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

function FragmentGroup({ group, colSpan, children }: { group: string; colSpan: number; children: ReactNode }) {
  return (
    <>
      {group && (
        <tr>
          <td colSpan={colSpan} className="pt-2 pb-0.5 text-sm font-semibold text-brand-700">
            {group}
          </td>
        </tr>
      )}
      {children}
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted">{label}：</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
