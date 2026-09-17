import { type Dec, decOrNull } from './decimal';
import type { NumLike } from './types';

export interface DiffLineInput {
  line_kind: 'ingredient' | 'component';
  ingredient_id: string | null;
  ingredient_name?: string | null;
  component_recipe_id?: string | null;
  component_name?: string | null;
  component_version_no?: number | null;
  quantity: NumLike | null;
  unit: string;
  waste_rate_override: NumLike | null;
  prep_note?: string;
  group_label?: string;
}

export interface DiffStepInput {
  step_no: number;
  instruction: string;
  duration_minutes: NumLike | null;
  temperature_c: NumLike | null;
  heat_level: string | null;
  is_critical: boolean;
}

export type ChangeKind = 'added' | 'removed' | 'changed' | 'same';

export interface LineDiff {
  key: string;
  name: string;
  change: ChangeKind;
  a: DiffLineInput | null;
  b: DiffLineInput | null;
  /** 同單位時的數量差（b − a） */
  qtyDelta: Dec | null;
  /** 同單位時的變化比例（(b − a) ÷ a） */
  qtyRatio: Dec | null;
  changedFields: string[];
}

function lineKey(l: DiffLineInput): string {
  return l.line_kind === 'ingredient' ? `i:${l.ingredient_id}` : `c:${l.component_recipe_id}`;
}

function lineName(l: DiffLineInput): string {
  return (l.line_kind === 'ingredient' ? l.ingredient_name : l.component_name) ?? '（未命名）';
}

function sameNum(a: NumLike | null, b: NumLike | null): boolean {
  const x = decOrNull(a);
  const y = decOrNull(b);
  if (!x || !y) return x === y;
  return x.eq(y);
}

/** 比較兩個版本的用料：同一原物料（或同一元件食譜）視為同一行；重複出現時依出現順序配對 */
export function diffLines(aLines: DiffLineInput[], bLines: DiffLineInput[]): LineDiff[] {
  const keyed = (lines: DiffLineInput[]) => {
    const seen = new Map<string, number>();
    return lines.map((l) => {
      const base = lineKey(l);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: `${base}#${n}`, line: l };
    });
  };
  const aKeyed = keyed(aLines);
  const bKeyed = keyed(bLines);
  const bMap = new Map(bKeyed.map((x) => [x.key, x.line]));
  const aMap = new Map(aKeyed.map((x) => [x.key, x.line]));
  const result: LineDiff[] = [];

  for (const { key, line: a } of aKeyed) {
    const b = bMap.get(key) ?? null;
    if (!b) {
      result.push({ key, name: lineName(a), change: 'removed', a, b: null, qtyDelta: null, qtyRatio: null, changedFields: [] });
      continue;
    }
    const changedFields: string[] = [];
    if (!sameNum(a.quantity, b.quantity) || a.unit !== b.unit) changedFields.push('用量');
    if (!sameNum(a.waste_rate_override, b.waste_rate_override)) changedFields.push('損耗率');
    if ((a.prep_note ?? '') !== (b.prep_note ?? '')) changedFields.push('處理方式');
    if ((a.group_label ?? '') !== (b.group_label ?? '')) changedFields.push('分組');
    if (a.line_kind === 'component' && a.component_version_no !== b.component_version_no) changedFields.push('元件版本');
    const qa = decOrNull(a.quantity);
    const qb = decOrNull(b.quantity);
    const comparable = qa && qb && a.unit === b.unit;
    result.push({
      key,
      name: lineName(b),
      change: changedFields.length ? 'changed' : 'same',
      a,
      b,
      qtyDelta: comparable ? qb.sub(qa) : null,
      qtyRatio: comparable && !qa.isZero() ? qb.sub(qa).div(qa) : null,
      changedFields,
    });
  }
  for (const { key, line: b } of bKeyed) {
    if (!aMap.has(key)) {
      result.push({ key, name: lineName(b), change: 'added', a: null, b, qtyDelta: null, qtyRatio: null, changedFields: [] });
    }
  }
  return result;
}

export interface StepDiff {
  stepNo: number;
  change: ChangeKind;
  a: DiffStepInput | null;
  b: DiffStepInput | null;
  changedFields: string[];
}

export function diffSteps(aSteps: DiffStepInput[], bSteps: DiffStepInput[]): StepDiff[] {
  const max = Math.max(aSteps.length, bSteps.length);
  const result: StepDiff[] = [];
  for (let i = 0; i < max; i++) {
    const a = aSteps[i] ?? null;
    const b = bSteps[i] ?? null;
    if (!a && b) {
      result.push({ stepNo: i + 1, change: 'added', a, b, changedFields: [] });
    } else if (a && !b) {
      result.push({ stepNo: i + 1, change: 'removed', a, b, changedFields: [] });
    } else if (a && b) {
      const changedFields: string[] = [];
      if (a.instruction.trim() !== b.instruction.trim()) changedFields.push('說明');
      if (!sameNum(a.duration_minutes, b.duration_minutes)) changedFields.push('時間');
      if (!sameNum(a.temperature_c, b.temperature_c)) changedFields.push('溫度');
      if ((a.heat_level ?? '') !== (b.heat_level ?? '')) changedFields.push('火力');
      if (a.is_critical !== b.is_critical) changedFields.push('關鍵管制點');
      result.push({ stepNo: i + 1, change: changedFields.length ? 'changed' : 'same', a, b, changedFields });
    }
  }
  return result;
}
