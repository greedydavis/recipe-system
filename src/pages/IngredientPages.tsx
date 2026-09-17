import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { can, useRole } from '../app/auth';
import { formatDate, numStr, todayIso, toNum } from '../app/format';
import { RequireRole } from '../app/Layout';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ChipGroup,
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
import type { IngredientDetail, IngredientListItem, SpecRow, Supplier, SupplierDetail } from '../data/types';
import { ingredientUnitCost } from '../domain/costing';
import { dec } from '../domain/decimal';
import { formatLineCost, formatNumber, formatPercent } from '../domain/format';
import type { CostingIngredient, Dimension } from '../domain/types';
import { BASE_UNIT, GLOBAL_UNITS } from '../domain/units';
import { DIMENSION_LABEL, INGREDIENT_CATEGORY_LABEL, RECIPE_TYPE_LABEL } from '../i18n/labels';

/** 顯示單價：g／ml 換算成每公斤／每公升比較好讀 */
function priceDisplay(ing: CostingIngredient): { text: string; missing: boolean } {
  const r = ingredientUnitCost(ing);
  if (!r.ok) return { text: r.issue.replace(`「${ing.name}」`, ''), missing: true };
  if (ing.base_dimension === 'mass') return { text: `$${formatLineCost(r.value.perBase.mul(1000))}/kg`, missing: false };
  if (ing.base_dimension === 'volume') return { text: `$${formatLineCost(r.value.perBase.mul(1000))}/L`, missing: false };
  return { text: `$${formatLineCost(r.value.perBase)}/個`, missing: false };
}

// ───────────────────────── 原物料列表 ─────────────────────────

export function IngredientsPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <IngredientList />
    </RequireRole>
  );
}

function IngredientList() {
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(params.get('missing') === '1');
  const [inactive, setInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = useRpc<IngredientListItem[]>('list_ingredients', { p_q: null, p_category: null, p_include_inactive: inactive });

  const term = q.trim();
  const rows = (list.data ?? [])
    .filter((i) => !term || i.name.includes(term) || i.code.includes(term))
    .filter((i) => !category || i.category === category)
    .filter((i) => !missingOnly || priceDisplay(i).missing);

  return (
    <div className="space-y-3">
      <PageHeader
        title="原物料"
        actions={
          <div className="flex gap-2">
            <Link to="/suppliers" className="inline-flex min-h-9 items-center px-2 text-sm text-brand-700">
              供應商
            </Link>
            <Button small onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              新增
            </Button>
          </div>
        }
      />
      <SearchInput value={q} onChange={setQ} placeholder="搜尋原物料名稱或編號" />
      <div className="-mx-4 overflow-x-auto px-4">
        <ChipGroup<string>
          label="分類"
          value={category}
          onChange={setCategory}
          allowClear
          options={Object.entries(INGREDIENT_CATEGORY_LABEL).map(([value, label]) => ({ value, label }))}
        />
      </div>
      <div className="flex flex-wrap gap-x-4">
        <Checkbox checked={missingOnly} onChange={setMissingOnly} label="只看缺價格" />
        <Checkbox checked={inactive} onChange={setInactive} label="含停用" />
      </div>

      {list.isLoading && <Loading />}
      {list.error && <ErrorState error={list.error} />}
      {list.data && rows.length === 0 && <EmptyState title="沒有符合的原物料" />}
      <div className="space-y-2">
        {rows.map((i) => {
          const p = priceDisplay(i);
          return (
            <Link key={i.id} to={`/ingredients/${i.id}`} className="block">
              <Card className="flex items-center gap-3 py-3 hover:bg-brand-50">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{i.name}</span>
                    {!i.is_active && <Badge>停用</Badge>}
                  </div>
                  <div className="text-sm text-muted">
                    {i.code}・{INGREDIENT_CATEGORY_LABEL[i.category]}・損耗 {formatPercent(dec(i.default_waste_rate))}・{i.used_in_count} 個食譜使用
                  </div>
                </div>
                <div className={cx('text-right text-sm tabular-nums', p.missing ? 'text-amber-800' : 'font-medium')}>{p.text}</div>
                <ChevronRight className="size-5 shrink-0 text-stone-400" aria-hidden />
              </Card>
            </Link>
          );
        })}
      </div>
      {creating && <IngredientFormSheet onClose={() => setCreating(false)} />}
    </div>
  );
}

function IngredientFormSheet({ ingredient, onClose }: { ingredient?: IngredientDetail; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(ingredient?.name ?? '');
  const [category, setCategory] = useState(ingredient?.category ?? 'other');
  const [base, setBase] = useState<Dimension>(ingredient?.base_dimension ?? 'mass');
  const [waste, setWaste] = useState(ingredient ? String(Number(ingredient.default_waste_rate) * 100) : '0');
  const [density, setDensity] = useState(numStr(ingredient?.density_g_per_ml));
  const [note, setNote] = useState(ingredient?.note ?? '');
  const [active, setActive] = useState(ingredient?.is_active ?? true);
  const save = useAction(() =>
    rpc<string>('upsert_ingredient', {
      p: {
        id: ingredient?.id ?? '',
        name,
        category,
        base_dimension: base,
        default_waste_rate: (toNum(waste) ?? 0) / 100,
        density_g_per_ml: toNum(density) ?? '',
        note,
        is_active: active,
      },
    }),
  );
  return (
    <Sheet
      open
      onClose={onClose}
      title={ingredient ? '編輯原物料' : '新增原物料'}
      footer={
        <Button
          block
          loading={save.isPending}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: (id) => {
                toast('已儲存');
                onClose();
                if (!ingredient) navigate(`/ingredients/${id}`);
              },
              onError: (e) => toast(e.message, 'danger'),
            })
          }
        >
          儲存
        </Button>
      }
    >
      <Field label="名稱">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="分類">
          {(id) => (
            <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(INGREDIENT_CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="基本單位" hint="成本都換算到這個單位">
          {(id) => (
            <Select id={id} value={base} onChange={(e) => setBase(e.target.value as Dimension)}>
              {Object.entries(DIMENSION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="預設損耗率（%）" hint="去皮、修清、去骨損失的比例">
          {(id) => <NumberInput id={id} value={waste} onChange={setWaste} />}
        </Field>
        <Field label="密度 g/ml（選填）" hint="重量與容量互換時使用">
          {(id) => <NumberInput id={id} value={density} onChange={setDensity} />}
        </Field>
      </div>
      <Field label="備註">{(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      {ingredient && <Checkbox checked={active} onChange={setActive} label="啟用中" />}
    </Sheet>
  );
}

// ───────────────────────── 原物料詳情 ─────────────────────────

export function IngredientDetailPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <IngredientDetailView />
    </RequireRole>
  );
}

function IngredientDetailView() {
  const { id = '' } = useParams();
  const role = useRole();
  const toast = useToast();
  const ing = useRpc<IngredientDetail>('get_ingredient', { p_id: id });
  const [editing, setEditing] = useState(false);
  const [unitSheet, setUnitSheet] = useState(false);
  const [specSheet, setSpecSheet] = useState<SpecRow | 'new' | null>(null);
  const [priceFor, setPriceFor] = useState<SpecRow | null>(null);
  const removeUnit = useAction((unitId: string) => rpc('delete_ingredient_unit', { p_id: unitId }));
  const voidPrice = useAction(({ priceId, reason }: { priceId: string; reason: string }) =>
    rpc('void_purchase_price', { p_id: priceId, p_reason: reason }),
  );

  if (ing.isLoading) return <Loading />;
  if (ing.error || !ing.data) return <ErrorState error={ing.error} />;
  const i = ing.data;
  const p = priceDisplay(i);
  const baseUnit = BASE_UNIT[i.base_dimension];

  return (
    <div className="space-y-6">
      <PageHeader
        back="/ingredients"
        title={i.name}
        subtitle={`${i.code}・${INGREDIENT_CATEGORY_LABEL[i.category]}${i.is_active ? '' : '・已停用'}`}
        actions={
          <Button small variant="secondary" onClick={() => setEditing(true)}>
            編輯
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="py-3">
          <div className="text-xs text-muted">目前單價</div>
          <div className={cx('font-semibold tabular-nums', p.missing && 'text-amber-800')}>{p.text}</div>
        </Card>
        <Card className="py-3">
          <div className="text-xs text-muted">基本單位</div>
          <div className="font-semibold">{DIMENSION_LABEL[i.base_dimension]}</div>
        </Card>
        <Card className="py-3">
          <div className="text-xs text-muted">預設損耗率</div>
          <div className="font-semibold tabular-nums">{formatPercent(dec(i.default_waste_rate))}</div>
        </Card>
        <Card className="py-3">
          <div className="text-xs text-muted">密度</div>
          <div className="font-semibold tabular-nums">{i.density_g_per_ml ? `${formatNumber(i.density_g_per_ml, 3)} g/ml` : '未設定'}</div>
        </Card>
      </div>
      {i.note && <p className="text-sm whitespace-pre-wrap text-muted">{i.note}</p>}

      <Section
        title="包裝規格與單價"
        action={
          <Button small variant="secondary" onClick={() => setSpecSheet('new')}>
            <Plus className="size-4" aria-hidden />
            規格
          </Button>
        }
      >
        {i.specs.length === 0 && <EmptyState title="還沒有包裝規格">例如「20 kg/箱」「1 台斤」；有規格和單價才能計算成本。</EmptyState>}
        <div className="space-y-3">
          {i.specs.map((s) => (
            <Card key={s.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{s.spec_name}</span>
                {s.is_default && <Badge tone="ok">預設（計算成本用）</Badge>}
                {!s.is_active && <Badge>停用</Badge>}
                <span className="text-sm text-muted">
                  {formatNumber(s.pack_qty)} {s.pack_unit === 'pc' ? '個' : s.pack_unit}
                  {s.supplier_name && `・${s.supplier_name}`}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button small variant="ghost" onClick={() => setSpecSheet(s)}>
                    編輯
                  </Button>
                  <Button small onClick={() => setPriceFor(s)}>
                    新增報價
                  </Button>
                </div>
              </div>
              {s.prices.length === 0 ? (
                <p className="text-sm text-muted">還沒有報價</p>
              ) : (
                <div className="divide-y divide-line rounded-xl ring-1 ring-line">
                  {s.prices.map((pr) => (
                    <div key={pr.id} className={cx('flex flex-wrap items-center gap-x-3 px-3 py-2 text-sm', pr.is_void && 'text-muted line-through')}>
                      <span className="w-24 tabular-nums">{formatDate(pr.effective_date)}</span>
                      <span className="font-semibold tabular-nums">${formatNumber(pr.price)}</span>
                      <span className="flex-1 text-muted">
                        {pr.note}
                        {pr.is_void && `（作廢：${pr.void_reason}）`}
                        {pr.effective_date > todayIso() && !pr.is_void && <Badge tone="info" className="ml-1 no-underline">未生效</Badge>}
                      </span>
                      <span className="text-xs text-muted">{pr.created_by_name}</span>
                      {can.approve(role) && !pr.is_void && (
                        <Button
                          small
                          variant="ghost"
                          onClick={() => {
                            const reason = prompt('作廢原因（例如：金額打錯）');
                            if (reason?.trim())
                              voidPrice.mutate({ priceId: pr.id, reason }, { onSuccess: () => toast('已作廢'), onError: (e) => toast(e.message, 'danger') });
                          }}
                        >
                          作廢
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted">單價只能新增不能修改；打錯請由創辦人作廢後重新新增。成本使用「預設規格」中生效日最新的一筆。</p>
      </Section>

      <Section
        title="專屬單位"
        action={
          <Button small variant="secondary" onClick={() => setUnitSheet(true)}>
            <Plus className="size-4" aria-hidden />
            單位
          </Button>
        }
      >
        {i.units.length === 0 ? (
          <p className="text-sm text-muted">例如「1 顆 = 60 g」「1 把 = 150 g」。系統內建 kg、台斤、兩、L、大匙、小匙等單位。</p>
        ) : (
          <Card className="divide-y divide-line py-0">
            {i.units.map((u) => (
              <div key={u.id} className="flex items-center gap-2 py-2.5 text-sm">
                <span className="flex-1">
                  1 {u.unit_name} = {formatNumber(u.qty_in_base, 3)} {baseUnit === 'pc' ? '個' : baseUnit}
                  {u.note && <span className="text-muted">・{u.note}</span>}
                </span>
                <Button
                  small
                  variant="ghost"
                  onClick={() =>
                    confirm(`刪除單位「${u.unit_name}」？`) &&
                    removeUnit.mutate(u.id!, { onSuccess: () => toast('已刪除'), onError: (e) => toast(e.message, 'danger') })
                  }
                >
                  刪除
                </Button>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="用到此原物料的食譜">
        {i.used_in.length === 0 ? (
          <p className="text-sm text-muted">還沒有食譜使用</p>
        ) : (
          <div className="space-y-2">
            {i.used_in.map((u) => (
              <Link key={u.version_id} to={`/versions/${u.version_id}?tab=cost`} className="block">
                <Card className="flex items-center gap-2 py-3 text-sm hover:bg-brand-50">
                  <span className="flex-1">
                    {u.recipe_name} v{u.version_no}
                    <span className="text-muted">・{RECIPE_TYPE_LABEL[u.recipe_type]}</span>
                  </span>
                  <StatusBadge status={u.status} />
                </Card>
              </Link>
            ))}
          </div>
        )}
        {i.used_in.length > 0 && <p className="text-xs text-muted">價格更新後，點進各版本的「成本」分頁可以看到新的每份成本與食材成本率。</p>}
      </Section>

      {editing && <IngredientFormSheet ingredient={i} onClose={() => setEditing(false)} />}
      {unitSheet && <UnitSheet ingredient={i} onClose={() => setUnitSheet(false)} />}
      {specSheet && <SpecSheet ingredient={i} spec={specSheet === 'new' ? undefined : specSheet} onClose={() => setSpecSheet(null)} />}
      {priceFor && <PriceSheet spec={priceFor} onClose={() => setPriceFor(null)} />}
    </div>
  );
}

function UnitSheet({ ingredient, onClose }: { ingredient: IngredientDetail; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const save = useAction(() =>
    rpc('upsert_ingredient_unit', { p: { ingredient_id: ingredient.id, unit_name: name, qty_in_base: toNum(qty), note } }),
  );
  const base = BASE_UNIT[ingredient.base_dimension];
  return (
    <Sheet
      open
      onClose={onClose}
      title="新增專屬單位"
      footer={
        <Button block loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast('已新增單位'), onClose()), onError: (e) => toast(e.message, 'danger') })}>
          儲存
        </Button>
      }
    >
      <div className="flex items-end gap-2">
        <span className="pb-3">1</span>
        <Field label="單位名稱" className="flex-1">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="顆、把、瓣、片" />}
        </Field>
        <span className="pb-3">=</span>
        <Field label="換算量" className="flex-1">
          {(id) => <NumberInput id={id} value={qty} onChange={setQty} />}
        </Field>
        <span className="pb-3">{base === 'pc' ? '個' : base}</span>
      </div>
      <Field label="備註（選填）">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：中型蛋平均" />}</Field>
    </Sheet>
  );
}

function SpecSheet({ ingredient, spec, onClose }: { ingredient: IngredientDetail; spec?: SpecRow; onClose: () => void }) {
  const toast = useToast();
  const suppliers = useRpc<Supplier[]>('list_suppliers', { p_q: null, p_include_inactive: false });
  const [name, setName] = useState(spec?.spec_name ?? '');
  const [qty, setQty] = useState(numStr(spec?.pack_qty));
  const [unit, setUnit] = useState(spec?.pack_unit ?? BASE_UNIT[ingredient.base_dimension]);
  const [supplier, setSupplier] = useState(spec?.supplier_id ?? '');
  const [isDefault, setIsDefault] = useState(spec?.is_default ?? ingredient.specs.length === 0);
  const [active, setActive] = useState(spec?.is_active ?? true);
  const [note, setNote] = useState(spec?.note ?? '');
  const save = useAction(() =>
    rpc('upsert_packaging_spec', {
      p: {
        id: spec?.id ?? '',
        ingredient_id: ingredient.id,
        spec_name: name,
        pack_qty: toNum(qty),
        pack_unit: unit,
        supplier_id: supplier,
        is_default: isDefault,
        is_active: active,
        note,
      },
    }),
  );
  const units = [...ingredient.units.map((u) => u.unit_name), ...GLOBAL_UNITS.map((u) => u.code)];
  return (
    <Sheet
      open
      onClose={onClose}
      title={spec ? '編輯包裝規格' : '新增包裝規格'}
      footer={
        <Button block loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast('已儲存規格'), onClose()), onError: (e) => toast(e.message, 'danger') })}>
          儲存
        </Button>
      }
    >
      <Field label="規格名稱" hint="採購時的叫法，例如「20 kg/箱」「1 台斤」「30 顆/盒」">
        {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="每包裝的數量">
        {(id) => (
          <div className="flex gap-2">
            <NumberInput id={id} value={qty} onChange={setQty} className="flex-1" />
            <Select aria-label="單位" value={unit} onChange={(e) => setUnit(e.target.value)} className="w-28">
              {units.map((u) => (
                <option key={u} value={u}>
                  {u === 'pc' ? '個' : u}
                </option>
              ))}
            </Select>
          </div>
        )}
      </Field>
      <Field label="供應商">
        {(id) => (
          <Select id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">未指定（例如市場現買）</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Checkbox checked={isDefault} onChange={setIsDefault} label="設為預設規格（計算成本使用）" />
      {spec && <Checkbox checked={active} onChange={setActive} label="啟用中" />}
      <Field label="備註">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </Sheet>
  );
}

function PriceSheet({ spec, onClose }: { spec: SpecRow; onClose: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const save = useAction(() =>
    rpc('add_purchase_price', { p_spec_id: spec.id, p_price: toNum(price), p_effective_date: date, p_note: note }),
  );
  return (
    <Sheet
      open
      onClose={onClose}
      title={`新增報價：${spec.spec_name}`}
      footer={
        <Button block loading={save.isPending} disabled={toNum(price) === null} onClick={() => save.mutate(undefined, { onSuccess: () => (toast('已新增報價'), onClose()), onError: (e) => toast(e.message, 'danger') })}>
          儲存
        </Button>
      }
    >
      <Notice tone="info">輸入實際支付的金額（含稅）。0 元也可以（例如水）。</Notice>
      <Field label="金額（元）">{(id) => <NumberInput id={id} value={price} onChange={setPrice} />}</Field>
      <Field label="生效日">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      <Field label="備註（選填）">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：9 月報價單" />}</Field>
    </Sheet>
  );
}

// ───────────────────────── 供應商 ─────────────────────────

export function SuppliersPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <SupplierList />
    </RequireRole>
  );
}

function SupplierList() {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const list = useRpc<Supplier[]>('list_suppliers', { p_q: null, p_include_inactive: true });
  const rows = (list.data ?? []).filter((s) => !q.trim() || s.name.includes(q.trim()));
  return (
    <div className="space-y-3">
      <PageHeader
        back="/ingredients"
        title="供應商"
        actions={
          <Button small onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden />
            新增
          </Button>
        }
      />
      <SearchInput value={q} onChange={setQ} placeholder="搜尋供應商" />
      {list.isLoading && <Loading />}
      {list.data && rows.length === 0 && <EmptyState title="沒有供應商" />}
      <div className="space-y-2">
        {rows.map((s) => (
          <Link key={s.id} to={`/suppliers/${s.id}`} className="block">
            <Card className="flex items-center gap-3 py-3 hover:bg-brand-50">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">
                  {s.name} {!s.is_active && <Badge>停用</Badge>}
                </div>
                <div className="text-sm text-muted">
                  {[s.contact_name, s.phone].filter(Boolean).join('・') || '—'}・{s.spec_count ?? 0} 個規格
                </div>
              </div>
              <ChevronRight className="size-5 text-stone-400" aria-hidden />
            </Card>
          </Link>
        ))}
      </div>
      {editing && <SupplierSheet supplier={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function SupplierDetailPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <SupplierDetailView />
    </RequireRole>
  );
}

function SupplierDetailView() {
  const { id = '' } = useParams();
  const s = useRpc<SupplierDetail>('get_supplier', { p_id: id });
  const [editing, setEditing] = useState(false);
  if (s.isLoading) return <Loading />;
  if (s.error || !s.data) return <ErrorState error={s.error} />;
  const d = s.data;
  return (
    <div className="space-y-6">
      <PageHeader
        back="/suppliers"
        title={d.name}
        subtitle={[d.contact_name, d.phone].filter(Boolean).join('・')}
        actions={
          <Button small variant="secondary" onClick={() => setEditing(true)}>
            編輯
          </Button>
        }
      />
      {d.note && <p className="text-sm whitespace-pre-wrap text-muted">{d.note}</p>}
      <Section title="供應的包裝規格">
        {d.specs.length === 0 ? (
          <p className="text-sm text-muted">還沒有規格指定這個供應商</p>
        ) : (
          <Card className="divide-y divide-line py-0">
            {d.specs.map((sp) => (
              <Link key={sp.id} to={`/ingredients/${sp.ingredient_id}`} className="flex items-center gap-2 py-3 text-sm hover:underline">
                <span className="flex-1">
                  {sp.ingredient_name}・{sp.spec_name}
                </span>
                {sp.latest_price ? (
                  <span className="tabular-nums">
                    ${formatNumber(sp.latest_price.price)}（{formatDate(sp.latest_price.effective_date)}）
                  </span>
                ) : (
                  <Badge tone="warn">無報價</Badge>
                )}
              </Link>
            ))}
          </Card>
        )}
      </Section>
      {editing && <SupplierSheet supplier={d} onClose={() => setEditing(false)} />}
    </div>
  );
}

function SupplierSheet({ supplier, onClose }: { supplier?: Supplier; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(supplier?.name ?? '');
  const [contact, setContact] = useState(supplier?.contact_name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [note, setNote] = useState(supplier?.note ?? '');
  const [active, setActive] = useState(supplier?.is_active ?? true);
  const save = useAction(() =>
    rpc('upsert_supplier', { p: { id: supplier?.id ?? '', name, contact_name: contact, phone, note, is_active: active } }),
  );
  return (
    <Sheet
      open
      onClose={onClose}
      title={supplier ? '編輯供應商' : '新增供應商'}
      footer={
        <Button block loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast('已儲存'), onClose()), onError: (e) => toast(e.message, 'danger') })}>
          儲存
        </Button>
      }
    >
      <Field label="名稱">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="聯絡人">{(id) => <Input id={id} value={contact} onChange={(e) => setContact(e.target.value)} />}</Field>
        <Field label="電話">{(id) => <Input id={id} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
      </div>
      <Field label="備註">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      {supplier && <Checkbox checked={active} onChange={setActive} label="合作中" />}
    </Sheet>
  );
}
