import { Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router';
import { todayIso, toNum } from '../app/format';
import {
  BottomBar,
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
  Select,
  cx,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type { IngredientListItem, Supplier } from '../data/types';
import { compatibleUnits, unitLabel } from '../domain/units';
import { INGREDIENT_CATEGORY_LABEL } from '../i18n/labels';
import { type PriceEntry, defaultPriceEntry, entryUnitPrice, priceDisplay } from '../app/prices';

type Row = PriceEntry;

/** 一頁輸入很多原物料的進貨金額：數量、單位先帶入預設規格，通常只要打金額 */
export function BatchPricesPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const ingredients = useRpc<IngredientListItem[]>('list_ingredients', { p_q: null, p_category: null, p_include_inactive: false });
  const suppliers = useRpc<Supplier[]>('list_suppliers', { p_q: null, p_include_inactive: false });
  const [date, setDate] = useState(todayIso());
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);
  const [rows, setRows] = useState<Record<string, Row>>({});

  const rowFor = (ing: IngredientListItem): Row => rows[ing.id] ?? defaultPriceEntry(ing);
  const setRow = (ing: IngredientListItem, patch: Partial<Row>) => setRows((all) => ({ ...all, [ing.id]: { ...rowFor(ing), ...patch } }));

  const list = useMemo(() => ingredients.data ?? [], [ingredients.data]);
  const filled = list.filter((i) => rows[i.id] && rows[i.id].price.trim() !== '');
  const invalid = filled.filter((i) => entryUnitPrice(i, rows[i.id]) === null);

  const term = q.trim();
  const shown = list
    .filter((i) => !term || i.name.includes(term) || i.code.includes(term))
    .filter((i) => !category || i.category === category)
    .filter((i) => !missingOnly || priceDisplay(i).missing || rows[i.id]?.price);

  const remove = useAction((ing: IngredientListItem) => rpc('delete_ingredient', { p_id: ing.id }));
  const save = useAction(() =>
    rpc<{ added: number; skipped: number; created_specs: number }>('batch_add_purchase_prices', {
      p: {
        effective_date: date,
        supplier_id: supplier,
        note,
        items: filled.map((i) => ({ ingredient_id: i.id, pack_qty: toNum(rows[i.id].qty), pack_unit: rows[i.id].unit, price: toNum(rows[i.id].price) })),
      },
    }),
  );

  // 有打了還沒儲存的金額時，離開頁面前先確認
  const dirty = filled.length > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (confirm('還有沒儲存的金額，確定離開？')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 金額欄按 Enter 跳到下一行的金額
  const nextPrice = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.querySelector<HTMLInputElement>(`[data-price-index="${index + 1}"]`)?.focus();
  };

  if (ingredients.isLoading) return <Loading />;
  if (ingredients.error) return <ErrorState error={ingredients.error} onRetry={() => ingredients.refetch()} />;

  return (
    <div className="space-y-4">
      <PageHeader back="/ingredients" title="批次輸入單價" subtitle="一頁打完進貨金額，按一次儲存；沒有食譜用過的原物料可以直接刪除" />

      <Card className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="生效日">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="供應商（選填）">
            {(id) => (
              <Select id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                <option value="">不指定</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="備註（選填）">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：10 月報價單" />}</Field>
        <p className="text-xs text-muted">
          金額是這個包裝實際付的錢（含稅）。包裝和原本的預設規格不一樣時，會自動建立新規格並改成預設，成本就用這次的價格；供應商只記在新建立的規格上。
        </p>
      </Card>

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
      <Checkbox checked={missingOnly} onChange={setMissingOnly} label="只看缺價格" />

      {list.length === 0 && <EmptyState title="還沒有原物料">先到「原物料」新增，或匯入菜單配方表。</EmptyState>}
      <Card className="divide-y divide-line p-0">
        {shown.map((ing, index) => {
          const row = rowFor(ing);
          const current = priceDisplay(ing);
          const preview = row.price.trim() ? entryUnitPrice(ing, row) : null;
          const hasPrice = row.price.trim() !== '';
          return (
            <div key={ing.id} className={cx('space-y-2 px-3 py-3', hasPrice && 'bg-brand-50')}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 font-semibold">{ing.name}</span>
                <span className={cx('shrink-0 text-xs tabular-nums', current.missing ? 'text-amber-800' : 'text-muted')}>
                  目前 {current.missing ? '缺價格' : current.text}
                </span>
                {/* 食譜用過的只能停用（到原物料頁編輯）；資料庫也會再檢查一次 */}
                {ing.used_in_count === 0 && (
                  <button
                    type="button"
                    aria-label={`刪除 ${ing.name}`}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (!confirm(`確定刪除「${ing.name}」？包裝規格與單價會一起刪除（操作紀錄裡查得到）。`)) return;
                      remove.mutate(ing, {
                        onSuccess: () => {
                          toast(`已刪除「${ing.name}」`);
                          setRows(({ [ing.id]: _, ...rest }) => rest);
                        },
                      });
                    }}
                    className="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-40"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <NumberInput
                  aria-label={`${ing.name} 包裝數量`}
                  value={row.qty}
                  onChange={(v) => setRow(ing, { qty: v })}
                  className="w-20"
                  placeholder="數量"
                />
                <Select aria-label={`${ing.name} 單位`} value={row.unit} onChange={(e) => setRow(ing, { unit: e.target.value })} className="w-24">
                  {compatibleUnits(ing, row.unit).map((u) => (
                    <option key={u} value={u}>
                      {unitLabel(u)}
                    </option>
                  ))}
                </Select>
                <NumberInput
                  aria-label={`${ing.name} 金額`}
                  data-price-index={index}
                  enterKeyHint="next"
                  value={row.price}
                  onChange={(v) => setRow(ing, { price: v })}
                  onKeyDown={(e) => nextPrice(e, index)}
                  className="flex-1"
                  placeholder="金額 $"
                />
              </div>
              {hasPrice && (
                <div className={cx('text-xs tabular-nums', preview ? 'text-brand-800' : 'text-red-700')}>
                  {preview ? `→ ${preview}` : '包裝數量或單位不對，換算不出單價'}
                </div>
              )}
            </div>
          );
        })}
        {list.length > 0 && shown.length === 0 && <p className="px-3 py-4 text-sm text-muted">沒有符合的原物料</p>}
      </Card>

      {invalid.length > 0 && (
        <Notice tone="danger">
          {invalid.map((i) => i.name).join('、')} 的包裝數量或單位不對，修正後才能儲存。
        </Notice>
      )}

      <BottomBar>
        <Button variant="secondary" onClick={() => navigate('/ingredients')}>
          返回
        </Button>
        <Button
          className="flex-1"
          disabled={filled.length === 0 || invalid.length > 0 || !date}
          loading={save.isPending}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: (r) => {
                toast(`已儲存 ${r.added} 筆單價${r.skipped ? `（${r.skipped} 筆之前已經記過）` : ''}${r.created_specs ? `，新建 ${r.created_specs} 個包裝規格` : ''}`);
                setRows({});
              },
            })
          }
        >
          {filled.length > 0 ? `儲存 ${filled.length} 筆` : '儲存'}
        </Button>
      </BottomBar>
    </div>
  );
}
