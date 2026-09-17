import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { RequireRole } from '../app/Layout';
import { numStr, toNum } from '../app/format';
import { PhotoStrip } from '../components/photos';
import {
  Badge,
  BottomBar,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Notice,
  NumberInput,
  PageHeader,
  SearchInput,
  Section,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
  cx,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type { IngredientListItem, RecipeDetail, RecipeListItem, VersionDetail } from '../data/types';
import { CostCalculator } from '../domain/costing';
import { decOrNull } from '../domain/decimal';
import { formatLineCost, formatPercent, formatPrice, formatServingCost } from '../domain/format';
import { priceMetrics } from '../domain/pricing';
import { isReferenceable } from '../domain/status';
import type { CostingBundle, CostingIngredient, CostingVersion, Dimension, OutputUnit, VersionStatus } from '../domain/types';
import { BASE_UNIT, COMPONENT_LINE_UNITS, GLOBAL_UNITS } from '../domain/units';
import { COMPONENT_KIND_LABEL, DIMENSION_LABEL, HEAT_LABEL, INGREDIENT_CATEGORY_LABEL } from '../i18n/labels';

interface DraftLine {
  id: string;
  line_kind: 'ingredient' | 'component';
  ingredient_id: string | null;
  component_version_id: string | null;
  name: string;
  component_status: VersionStatus | null;
  quantity: string;
  unit: string;
  waste_percent: string;
  prep_note: string;
  group_label: string;
  expanded: boolean;
}

interface DraftStep {
  id: string;
  instruction: string;
  duration_minutes: string;
  temperature_c: string;
  heat_level: string;
  is_critical: boolean;
  critical_note: string;
  persisted: boolean;
}

interface DraftForm {
  title: string;
  change_note: string;
  batch_output_qty: string;
  batch_output_unit: OutputUnit;
  serving_qty: string;
  serving_unit: OutputUnit;
  output_density_g_per_ml: string;
  prep_minutes: string;
  cook_minutes: string;
  storage_method: string;
  shelf_life_hours: string;
  notes: string;
  lines: DraftLine[];
  steps: DraftStep[];
}

function formFromVersion(v: VersionDetail): DraftForm {
  return {
    title: v.title,
    change_note: v.change_note,
    batch_output_qty: numStr(v.batch_output_qty),
    batch_output_unit: v.batch_output_unit ?? 'g',
    serving_qty: numStr(v.serving_qty),
    serving_unit: v.serving_unit ?? 'g',
    output_density_g_per_ml: numStr(v.output_density_g_per_ml),
    prep_minutes: numStr(v.prep_minutes),
    cook_minutes: numStr(v.cook_minutes),
    storage_method: v.storage_method,
    shelf_life_hours: numStr(v.shelf_life_hours),
    notes: v.notes,
    lines: v.lines.map((l) => ({
      id: l.id,
      line_kind: l.line_kind,
      ingredient_id: l.ingredient_id,
      component_version_id: l.component_version_id,
      name: l.line_kind === 'ingredient' ? (l.ingredient_name ?? '') : `${l.component_name} v${l.component_version_no}`,
      component_status: l.component_status,
      quantity: numStr(l.quantity),
      unit: l.unit,
      waste_percent: l.waste_rate_override === null ? '' : String(Number(l.waste_rate_override) * 100),
      prep_note: l.prep_note,
      group_label: l.group_label,
      expanded: false,
    })),
    steps: v.steps.map((s) => ({
      id: s.id,
      instruction: s.instruction,
      duration_minutes: numStr(s.duration_minutes),
      temperature_c: numStr(s.temperature_c),
      heat_level: s.heat_level ?? '',
      is_critical: s.is_critical,
      critical_note: s.critical_note,
      persisted: true,
    })),
  };
}

function payloadFromForm(form: DraftForm) {
  return {
    title: form.title,
    change_note: form.change_note,
    batch_output_qty: toNum(form.batch_output_qty) ?? '',
    batch_output_unit: form.batch_output_unit,
    serving_qty: toNum(form.serving_qty) ?? '',
    serving_unit: form.serving_unit,
    output_density_g_per_ml: toNum(form.output_density_g_per_ml) ?? '',
    prep_minutes: toNum(form.prep_minutes) ?? '',
    cook_minutes: toNum(form.cook_minutes) ?? '',
    storage_method: form.storage_method,
    shelf_life_hours: toNum(form.shelf_life_hours) === null ? '' : Math.round(toNum(form.shelf_life_hours)!),
    notes: form.notes,
    lines: form.lines.map((l) => ({
      id: l.id,
      line_kind: l.line_kind,
      ingredient_id: l.ingredient_id,
      component_version_id: l.component_version_id,
      quantity: toNum(l.quantity) ?? '',
      unit: l.unit,
      waste_rate_override: toNum(l.waste_percent) === null ? '' : toNum(l.waste_percent)! / 100,
      prep_note: l.prep_note,
      group_label: l.group_label,
    })),
    steps: form.steps.map((s) => ({
      id: s.id,
      instruction: s.instruction,
      duration_minutes: toNum(s.duration_minutes) ?? '',
      temperature_c: toNum(s.temperature_c) ?? '',
      heat_level: s.heat_level,
      is_critical: s.is_critical,
      critical_note: s.critical_note,
    })),
  };
}

export function VersionEditPage() {
  return (
    <RequireRole roles={['founder', 'chef']}>
      <Editor />
    </RequireRole>
  );
}

function Editor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const version = useRpc<VersionDetail>('get_version', { p_id: id });
  const ingredients = useRpc<IngredientListItem[]>('list_ingredients', { p_q: null, p_category: null, p_include_inactive: true });
  const [form, setForm] = useState<DraftForm | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [revision, setRevision] = useState(0);
  const [picker, setPicker] = useState<'ingredient' | 'component' | null>(null);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    const v = version.data;
    if (!v || loadedFor.current === `${v.id}:${v.revision}`) return;
    loadedFor.current = `${v.id}:${v.revision}`;
    const f = formFromVersion(v);
    setForm(f);
    setSavedJson(JSON.stringify(payloadFromForm(f)));
    setRevision(v.revision);
  }, [version.data]);

  const dirty = form ? JSON.stringify(payloadFromForm(form)) !== savedJson : false;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (confirm('草案有未儲存的修改，確定離開？')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const save = useAction(async (f: DraftForm) => {
    const newRevision = await rpc<number>('save_version_draft', { p_version_id: id, p_revision: revision, p: payloadFromForm(f) });
    return { newRevision, json: JSON.stringify(payloadFromForm(f)) };
  });

  const update = useCallback((patch: Partial<DraftForm>) => setForm((f) => (f ? { ...f, ...patch } : f)), []);

  if (version.isLoading || !form) return version.error ? <ErrorState error={version.error} /> : <Loading />;
  const v = version.data!;
  if (v.status !== 'draft') {
    return (
      <div className="space-y-4">
        <PageHeader back={`/versions/${id}`} title={`${v.recipe.name} v${v.version_no}`} />
        <Notice tone="info" title="此版本不是草案，不能編輯">
          目前狀態：<StatusBadge status={v.status} />。要修改請回到版本頁「複製為新版本」。
        </Notice>
      </div>
    );
  }

  const isDish = v.recipe.type === 'dish';
  const ingredientMap = new Map((ingredients.data ?? []).map((i) => [i.id, i]));

  const doSave = () =>
    save.mutate(form, {
      onSuccess: ({ newRevision, json }) => {
        setRevision(newRevision);
        setSavedJson(json);
        loadedFor.current = `${v.id}:${newRevision}`;
        setForm((f) => (f ? { ...f, steps: f.steps.map((s) => ({ ...s, persisted: true })) } : f));
        toast('已儲存草案');
      },
      onError: (e) => toast(e.message, 'danger'),
    });

  return (
    <div className="space-y-6">
      <PageHeader
        back={`/versions/${id}`}
        title={`編輯 ${v.recipe.name} v${v.version_no}`}
        subtitle={
          <span className="flex items-center gap-2">
            <StatusBadge status="draft" />
            {dirty ? <Badge tone="warn">尚未儲存</Badge> : <span>已儲存</span>}
          </span>
        }
      />

      <Section title="版本資訊">
        <Card className="space-y-3">
          <Field label="版本標題" hint="簡短描述這一版的重點，例如「大骨增量、減鹽」">
            {(fid) => <Input id={fid} value={form.title} onChange={(e) => update({ title: e.target.value })} />}
          </Field>
          <Field label="修改說明">
            {(fid) => <Textarea id={fid} rows={2} value={form.change_note} onChange={(e) => update({ change_note: e.target.value })} />}
          </Field>
        </Card>
      </Section>

      <Section title="產量">
        <Card className="space-y-3">
          {isDish ? (
            <QtyUnit
              label="每份克重（成品一份的重量或容量）"
              qty={form.serving_qty}
              unit={form.serving_unit}
              onChange={(qty, unit) => update({ serving_qty: qty, serving_unit: unit })}
            />
          ) : (
            <>
              <QtyUnit
                label="批次產量（實際過濾或完成後的量）"
                qty={form.batch_output_qty}
                unit={form.batch_output_unit}
                onChange={(qty, unit) => update({ batch_output_qty: qty, batch_output_unit: unit })}
              />
              <QtyUnit
                label="每份量（一碗或一份使用多少）"
                qty={form.serving_qty}
                unit={form.serving_unit}
                onChange={(qty, unit) => update({ serving_qty: qty, serving_unit: unit })}
              />
            </>
          )}
          <Field label="成品密度 g/ml（選填）" hint="產量用 ml 記錄、但要計算出成率或用重量引用時才需要；湯底約 1.0">
            {(fid) => (
              <NumberInput id={fid} value={form.output_density_g_per_ml} onChange={(val) => update({ output_density_g_per_ml: val })} />
            )}
          </Field>
        </Card>
      </Section>

      <Section
        title={`用料（${form.lines.length}）`}
        action={
          <div className="flex gap-2">
            <Button small variant="secondary" onClick={() => setPicker('ingredient')}>
              <Plus className="size-4" aria-hidden />
              原物料
            </Button>
            <Button small variant="secondary" onClick={() => setPicker('component')}>
              <Plus className="size-4" aria-hidden />
              元件
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted">用量一律填「處理後、烹煮前的淨重」；還沒確定的用量可以先留空。</p>
        {form.lines.length === 0 ? (
          <EmptyState title="還沒有用料" />
        ) : (
          <div className="space-y-2">
            {form.lines.map((line, index) => (
              <LineEditor
                key={line.id}
                line={line}
                index={index}
                total={form.lines.length}
                ingredient={line.ingredient_id ? ingredientMap.get(line.ingredient_id) : undefined}
                groups={[...new Set(form.lines.map((l) => l.group_label).filter(Boolean))]}
                onChange={(patch) => update({ lines: form.lines.map((l) => (l.id === line.id ? { ...l, ...patch } : l)) })}
                onMove={(dir) => update({ lines: move(form.lines, index, dir) })}
                onRemove={() => update({ lines: form.lines.filter((l) => l.id !== line.id) })}
              />
            ))}
          </div>
        )}
        <LiveCost versionId={id} form={form} isDish={isDish} ingredients={ingredients.data} versionNo={v.version_no} recipeName={v.recipe.name} />
      </Section>

      <Section
        title={`步驟（${form.steps.length}）`}
        action={
          <Button
            small
            variant="secondary"
            onClick={() =>
              update({
                steps: [
                  ...form.steps,
                  {
                    id: crypto.randomUUID(),
                    instruction: '',
                    duration_minutes: '',
                    temperature_c: '',
                    heat_level: '',
                    is_critical: false,
                    critical_note: '',
                    persisted: false,
                  },
                ],
              })
            }
          >
            <Plus className="size-4" aria-hidden />
            步驟
          </Button>
        }
      >
        {form.steps.length === 0 ? (
          <EmptyState title="還沒有步驟" />
        ) : (
          <div className="space-y-2">
            {form.steps.map((step, index) => (
              <StepEditor
                key={step.id}
                step={step}
                index={index}
                total={form.steps.length}
                photos={v.steps.find((s) => s.id === step.id)?.photos ?? []}
                onChange={(patch) => update({ steps: form.steps.map((s) => (s.id === step.id ? { ...s, ...patch } : s)) })}
                onMove={(dir) => update({ steps: move(form.steps, index, dir) })}
                onRemove={() => update({ steps: form.steps.filter((s) => s.id !== step.id) })}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="成品照">
        <PhotoStrip photos={v.photos} target={{ version_id: v.id }} canAdd canDelete large />
      </Section>

      <Section title="時間、保存與備註">
        <Card className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="前置時間（分鐘）">
              {(fid) => <NumberInput id={fid} value={form.prep_minutes} onChange={(val) => update({ prep_minutes: val })} />}
            </Field>
            <Field label="烹調時間（分鐘）">
              {(fid) => <NumberInput id={fid} value={form.cook_minutes} onChange={(val) => update({ cook_minutes: val })} />}
            </Field>
          </div>
          <Field label="保存方式">
            {(fid) => (
              <Textarea
                id={fid}
                rows={2}
                value={form.storage_method}
                onChange={(e) => update({ storage_method: e.target.value })}
                placeholder="例如：快速冷卻後冷藏 0–5°C，密封標示日期"
              />
            )}
          </Field>
          <Field label="保存期限（小時）">
            {(fid) => <NumberInput id={fid} value={form.shelf_life_hours} onChange={(val) => update({ shelf_life_hours: val })} />}
          </Field>
          <Field label="備註">
            {(fid) => <Textarea id={fid} value={form.notes} onChange={(e) => update({ notes: e.target.value })} />}
          </Field>
        </Card>
      </Section>

      <BottomBar>
        <Button variant="secondary" onClick={() => navigate(`/versions/${id}`)}>
          返回
        </Button>
        <Button className="flex-1" loading={save.isPending} disabled={!dirty} onClick={doSave}>
          {dirty ? '儲存草案' : '已儲存'}
        </Button>
      </BottomBar>

      {picker === 'ingredient' && (
        <IngredientPicker
          ingredients={ingredients.data ?? []}
          onClose={() => setPicker(null)}
          onPick={(ing) => {
            update({
              lines: [
                ...form.lines,
                {
                  id: crypto.randomUUID(),
                  line_kind: 'ingredient',
                  ingredient_id: ing.id,
                  component_version_id: null,
                  name: ing.name,
                  component_status: null,
                  quantity: '',
                  unit: defaultUnit(ing),
                  waste_percent: '',
                  prep_note: '',
                  group_label: form.lines[form.lines.length - 1]?.group_label ?? '',
                  expanded: false,
                },
              ],
            });
            setPicker(null);
          }}
        />
      )}
      {picker === 'component' && (
        <ComponentPicker
          currentRecipeId={v.recipe.id}
          onClose={() => setPicker(null)}
          onPick={(recipe, version) => {
            update({
              lines: [
                ...form.lines,
                {
                  id: crypto.randomUUID(),
                  line_kind: 'component',
                  ingredient_id: null,
                  component_version_id: version.id,
                  name: `${recipe.name} v${version.version_no}`,
                  component_status: version.status,
                  quantity: '',
                  unit: '份',
                  waste_percent: '',
                  prep_note: '',
                  group_label: form.lines[form.lines.length - 1]?.group_label ?? '',
                  expanded: false,
                },
              ],
            });
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

function move<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list;
  const copy = list.slice();
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}

function defaultUnit(ing: CostingIngredient): string {
  if (ing.base_dimension === 'count' && ing.units.length > 0) return ing.units[0].unit_name;
  return BASE_UNIT[ing.base_dimension];
}

function unitOptions(ing: CostingIngredient | undefined, current: string): string[] {
  if (!ing) return [current];
  const options = new Set<string>();
  ing.units.forEach((u) => options.add(u.unit_name));
  const dims: Dimension[] = [ing.base_dimension];
  if (ing.density_g_per_ml && ing.base_dimension !== 'count') dims.push(ing.base_dimension === 'mass' ? 'volume' : 'mass');
  GLOBAL_UNITS.filter((u) => dims.includes(u.dimension)).forEach((u) => options.add(u.code));
  options.add(current);
  return [...options];
}

function QtyUnit({
  label,
  qty,
  unit,
  onChange,
}: {
  label: string;
  qty: string;
  unit: OutputUnit;
  onChange: (qty: string, unit: OutputUnit) => void;
}) {
  return (
    <Field label={label}>
      {(fid) => (
        <div className="flex gap-2">
          <NumberInput id={fid} value={qty} onChange={(val) => onChange(val, unit)} className="flex-1" />
          <Select aria-label="單位" value={unit} onChange={(e) => onChange(qty, e.target.value as OutputUnit)} className="w-24">
            <option value="g">g</option>
            <option value="ml">ml</option>
          </Select>
        </div>
      )}
    </Field>
  );
}

function LineEditor({
  line,
  index,
  total,
  ingredient,
  groups,
  onChange,
  onMove,
  onRemove,
}: {
  line: DraftLine;
  index: number;
  total: number;
  ingredient?: IngredientListItem;
  groups: string[];
  onChange: (patch: Partial<DraftLine>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const units = line.line_kind === 'component' ? COMPONENT_LINE_UNITS : unitOptions(ingredient, line.unit);
  const listId = `groups-${line.id}`;
  return (
    <Card className={cx('space-y-2 p-3', line.component_status === 'retired' && 'ring-2 ring-amber-300')}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {line.name}
            {line.line_kind === 'component' && <Badge className="ml-2">元件</Badge>}
            {line.component_status === 'retired' && (
              <Badge tone="warn" className="ml-1">
                已被取代
              </Badge>
            )}
          </div>
          {line.group_label && <div className="text-xs text-muted">分組：{line.group_label}</div>}
        </div>
        <button type="button" aria-label="上移" disabled={index === 0} onClick={() => onMove(-1)} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-stone-100 disabled:opacity-30">
          <ArrowUp className="size-4" />
        </button>
        <button type="button" aria-label="下移" disabled={index === total - 1} onClick={() => onMove(1)} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-stone-100 disabled:opacity-30">
          <ArrowDown className="size-4" />
        </button>
        <button type="button" aria-label="刪除此行" onClick={onRemove} className="flex size-9 items-center justify-center rounded-lg text-red-700 hover:bg-red-50">
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="flex gap-2">
        <NumberInput
          aria-label={`${line.name} 用量`}
          value={line.quantity}
          onChange={(val) => onChange({ quantity: val })}
          placeholder="用量待填"
          className="flex-1"
        />
        <Select aria-label={`${line.name} 單位`} value={line.unit} onChange={(e) => onChange({ unit: e.target.value })} className="w-28">
          {units.map((u) => (
            <option key={u} value={u}>
              {u === 'pc' ? '個' : u}
            </option>
          ))}
        </Select>
      </div>
      <button
        type="button"
        onClick={() => onChange({ expanded: !line.expanded })}
        className="flex min-h-9 items-center gap-1 text-sm text-brand-700"
        aria-expanded={line.expanded}
      >
        {line.expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        處理方式、分組{line.line_kind === 'ingredient' ? '、損耗率' : ''}
        {(line.prep_note || line.waste_percent) && !line.expanded && <span className="text-muted">（已填）</span>}
      </button>
      {line.expanded && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="處理方式" className="sm:col-span-2">
            {(fid) => <Input id={fid} value={line.prep_note} onChange={(e) => onChange({ prep_note: e.target.value })} placeholder="例如：切段 3 cm" />}
          </Field>
          <Field label="分組">
            {(fid) => (
              <>
                <Input id={fid} list={listId} value={line.group_label} onChange={(e) => onChange({ group_label: e.target.value })} placeholder="例如：爆香料" />
                <datalist id={listId}>
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          {line.line_kind === 'ingredient' && (
            <Field
              label="損耗率（%）"
              hint={`留空使用原物料預設 ${ingredient ? formatPercent(decOrNull(ingredient.default_waste_rate)) : '—'}`}
            >
              {(fid) => <NumberInput id={fid} value={line.waste_percent} onChange={(val) => onChange({ waste_percent: val })} />}
            </Field>
          )}
        </div>
      )}
    </Card>
  );
}

function StepEditor({
  step,
  index,
  total,
  photos,
  onChange,
  onMove,
  onRemove,
}: {
  step: DraftStep;
  index: number;
  total: number;
  photos: VersionDetail['steps'][number]['photos'];
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <Card className={cx('space-y-2 p-3', step.is_critical && 'ring-2 ring-red-300')}>
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700">{index + 1}</div>
        <div className="flex-1" />
        <button type="button" aria-label="上移" disabled={index === 0} onClick={() => onMove(-1)} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-stone-100 disabled:opacity-30">
          <ArrowUp className="size-4" />
        </button>
        <button type="button" aria-label="下移" disabled={index === total - 1} onClick={() => onMove(1)} className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-stone-100 disabled:opacity-30">
          <ArrowDown className="size-4" />
        </button>
        <button type="button" aria-label="刪除步驟" onClick={onRemove} className="flex size-9 items-center justify-center rounded-lg text-red-700 hover:bg-red-50">
          <Trash2 className="size-4" />
        </button>
      </div>
      <Textarea aria-label={`步驟 ${index + 1} 說明`} value={step.instruction} onChange={(e) => onChange({ instruction: e.target.value })} placeholder="作法說明" />
      <div className="grid grid-cols-3 gap-2">
        <Field label="時間（分）">
          {(fid) => <NumberInput id={fid} value={step.duration_minutes} onChange={(val) => onChange({ duration_minutes: val })} />}
        </Field>
        <Field label="溫度（°C）">
          {(fid) => <NumberInput id={fid} value={step.temperature_c} onChange={(val) => onChange({ temperature_c: val })} allowNegative />}
        </Field>
        <Field label="火力">
          {(fid) => (
            <Select id={fid} value={step.heat_level} onChange={(e) => onChange({ heat_level: e.target.value })}>
              <option value="">—</option>
              {Object.entries(HEAT_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Checkbox checked={step.is_critical} onChange={(c) => onChange({ is_critical: c })} label="關鍵管制點（例如中心溫度、冷卻時間）" />
      {step.is_critical && (
        <Input aria-label="管制標準" value={step.critical_note} onChange={(e) => onChange({ critical_note: e.target.value })} placeholder="例如：中心溫度 ≥ 75°C" />
      )}
      {step.persisted ? (
        <PhotoStrip photos={photos} target={{ step_id: step.id }} canAdd canDelete />
      ) : (
        <p className="text-xs text-muted">儲存草案後可以加步驟照片</p>
      )}
    </Card>
  );
}

function LiveCost({
  versionId,
  form,
  isDish,
  ingredients,
  versionNo,
  recipeName,
}: {
  versionId: string;
  form: DraftForm;
  isDish: boolean;
  ingredients?: IngredientListItem[];
  versionNo: number;
  recipeName: string;
}) {
  const componentIds = useMemo(
    () => [...new Set([versionId, ...form.lines.map((l) => l.component_version_id).filter((x): x is string => !!x)])].sort(),
    [versionId, form.lines],
  );
  const bundle = useRpc<CostingBundle>('get_costing_bundle', { p_version_ids: componentIds });

  const result = useMemo(() => {
    if (!bundle.data || !ingredients) return null;
    const saved = bundle.data.versions[versionId];
    const draft: CostingVersion = {
      ...saved,
      id: '__draft__',
      status: 'draft',
      batch_output_qty: toNum(isDish ? form.serving_qty : form.batch_output_qty),
      batch_output_unit: isDish ? form.serving_unit : form.batch_output_unit,
      serving_qty: toNum(form.serving_qty),
      serving_unit: form.serving_unit,
      output_density_g_per_ml: toNum(form.output_density_g_per_ml),
      lines: form.lines.map((l, i) => ({
        id: l.id,
        line_kind: l.line_kind,
        ingredient_id: l.ingredient_id,
        component_version_id: l.component_version_id,
        quantity: toNum(l.quantity),
        unit: l.unit,
        waste_rate_override: toNum(l.waste_percent) === null ? null : toNum(l.waste_percent)! / 100,
        sort_order: i,
      })),
    };
    const merged: CostingBundle = {
      ...bundle.data,
      versions: { ...bundle.data.versions, __draft__: draft },
      ingredients: { ...bundle.data.ingredients, ...Object.fromEntries(ingredients.map((i) => [i.id, i])) },
    };
    const cost = new CostCalculator(merged).version('__draft__');
    return { cost, metrics: priceMetrics(cost.servingCost, draft, merged.settings) };
  }, [bundle.data, ingredients, form, versionId, isDish]);

  if (!result) return null;
  const { cost, metrics } = result;
  return (
    <Card className="bg-brand-50">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm text-muted">
          即時成本試算（{recipeName} v{versionNo}，未儲存也會更新）
        </div>
        {cost.isComplete ? (
          <div className="text-lg font-semibold tabular-nums">每份 ${formatServingCost(cost.servingCost)}</div>
        ) : (
          <div className="text-sm text-amber-800">不完整，已知 ${formatLineCost(cost.knownCost)}</div>
        )}
      </div>
      {cost.isComplete && isDish && (
        <div className="mt-1 text-sm tabular-nums">
          食材成本率 {formatPercent(metrics.foodCostRate)}・建議售價 {metrics.suggestedPrice ? `$${formatPrice(metrics.suggestedPrice)}` : '—'}
        </div>
      )}
      {cost.isComplete && !isDish && <div className="mt-1 text-sm tabular-nums">出成率 {formatPercent(cost.yieldRate)}</div>}
      {!cost.isComplete && cost.issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">
          {cost.issues.slice(0, 5).map((i) => (
            <li key={i}>{i}</li>
          ))}
          {cost.issues.length > 5 && <li>還有 {cost.issues.length - 5} 項</li>}
        </ul>
      )}
    </Card>
  );
}

function IngredientPicker({
  ingredients,
  onClose,
  onPick,
}: {
  ingredients: IngredientListItem[];
  onClose: () => void;
  onPick: (ing: IngredientListItem) => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [base, setBase] = useState<Dimension>('mass');
  const [category, setCategory] = useState('other');
  const create = useAction((p: Record<string, unknown>) => rpc<string>('upsert_ingredient', { p }));
  const term = q.trim();
  const matches = ingredients.filter((i) => i.is_active && (!term || i.name.includes(term) || i.code.includes(term))).slice(0, 50);
  const exact = ingredients.some((i) => i.name === term);

  return (
    <Sheet open title="加入原物料" onClose={onClose}>
      <SearchInput value={q} onChange={setQ} placeholder="搜尋原物料" />
      <div className="divide-y divide-line">
        {matches.map((i) => (
          <button key={i.id} type="button" onClick={() => onPick(i)} className="flex min-h-12 w-full items-center gap-2 py-2 text-left hover:bg-brand-50">
            <span className="flex-1">{i.name}</span>
            <span className="text-xs text-muted">{INGREDIENT_CATEGORY_LABEL[i.category]}</span>
            {!i.default_spec?.price && <Badge tone="warn">缺價格</Badge>}
          </button>
        ))}
        {matches.length === 0 && <p className="py-3 text-sm text-muted">找不到「{term}」</p>}
      </div>
      {term && !exact && (
        <Card className="space-y-3 bg-brand-50">
          {!creating ? (
            <Button variant="secondary" block onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              快速新增「{term}」
            </Button>
          ) : (
            <>
              <div className="font-medium">快速新增「{term}」</div>
              <Field label="基本單位">
                {(fid) => (
                  <Select id={fid} value={base} onChange={(e) => setBase(e.target.value as Dimension)}>
                    {Object.entries(DIMENSION_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="分類">
                {(fid) => (
                  <Select id={fid} value={category} onChange={(e) => setCategory(e.target.value)}>
                    {Object.entries(INGREDIENT_CATEGORY_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="text-xs text-muted">價格、損耗率與包裝規格可以之後在「原物料」補上；缺價格時成本會顯示不完整。</p>
              <Button
                block
                loading={create.isPending}
                onClick={() =>
                  create.mutate(
                    { name: term, base_dimension: base, category },
                    {
                      onSuccess: (newId) => {
                        toast(`已新增原物料「${term}」`);
                        onPick({
                          id: newId,
                          code: '',
                          name: term,
                          category,
                          base_dimension: base,
                          default_waste_rate: 0,
                          density_g_per_ml: null,
                          units: [],
                          default_spec: null,
                          note: '',
                          is_active: true,
                          used_in_count: 0,
                        });
                      },
                      onError: (e) => toast(e.message, 'danger'),
                    },
                  )
                }
              >
                新增並加入
              </Button>
            </>
          )}
        </Card>
      )}
    </Sheet>
  );
}

function ComponentPicker({
  currentRecipeId,
  onClose,
  onPick,
}: {
  currentRecipeId: string;
  onClose: () => void;
  onPick: (recipe: RecipeDetail, version: RecipeDetail['versions'][number]) => void;
}) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRpc<RecipeListItem[]>('list_recipes', { p_type: 'component', p_q: null, p_include_archived: false });
  const detail = useRpc<RecipeDetail>('get_recipe', { p_id: selected }, { enabled: !!selected });
  const term = q.trim();
  const matches = (list.data ?? []).filter((r) => r.id !== currentRecipeId && (!term || r.name.includes(term)));

  return (
    <Sheet open title={selected ? '選擇版本' : '加入元件'} onClose={onClose}>
      {!selected ? (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="搜尋湯底、醬料、配料" />
          {list.isLoading && <Loading />}
          <div className="divide-y divide-line">
            {matches.map((r) => (
              <button key={r.id} type="button" onClick={() => setSelected(r.id)} className="flex min-h-12 w-full items-center gap-2 py-2 text-left hover:bg-brand-50">
                <span className="flex-1">{r.name}</span>
                <span className="text-xs text-muted">{COMPONENT_KIND_LABEL[r.component_kind ?? 'other']}</span>
                <StatusBadge status={r.locked ? 'locked' : r.latest.status} />
              </button>
            ))}
            {list.data && matches.length === 0 && <p className="py-3 text-sm text-muted">沒有符合的元件；請先到「食譜 → 元件」建立。</p>}
          </div>
        </>
      ) : (
        <>
          <Button small variant="ghost" onClick={() => setSelected(null)}>
            ← 回到元件清單
          </Button>
          {detail.isLoading && <Loading />}
          {detail.data && (
            <div className="space-y-2">
              <p className="text-sm text-muted">只能引用已凍結的版本（試菜中、待核准、已定版）。菜品要定版時，引用的元件也必須是已定版。</p>
              {detail.data.versions.map((ver) => {
                const ok = isReferenceable(ver.status);
                return (
                  <button
                    key={ver.id}
                    type="button"
                    disabled={!ok}
                    onClick={() => onPick(detail.data!, ver)}
                    className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2 text-left ring-1 ring-line hover:bg-brand-50 disabled:opacity-50"
                  >
                    <span className="font-semibold">v{ver.version_no}</span>
                    <span className="flex-1 truncate text-sm">{ver.title}</span>
                    <StatusBadge status={ver.status} />
                  </button>
                );
              })}
              <Link to={`/recipes/${detail.data.id}`} className="inline-block min-h-11 py-2 text-sm text-brand-700">
                查看元件詳情 →
              </Link>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
