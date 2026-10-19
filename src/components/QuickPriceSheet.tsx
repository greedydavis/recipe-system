import { useState } from 'react';
import { Link } from 'react-router';
import { todayIso, toNum } from '../app/format';
import { defaultPriceEntry, entryUnitPrice, priceDisplay } from '../app/prices';
import { rpc, useAction } from '../data/api';
import type { CostingIngredient } from '../domain/types';
import { compatibleUnits, unitLabel } from '../domain/units';
import { Button, Field, Input, Notice, NumberInput, Select, Sheet, cx, useToast } from './ui';

/**
 * 在食譜裡直接更新某個原物料的進貨金額（和「批次輸入單價」同一套規則：
 * 包裝和預設規格不同時會建立新規格並設為預設，成本就用這次的價格）。
 */
export function QuickPriceSheet({
  ingredient,
  lineInfo,
  onClose,
}: {
  ingredient: CostingIngredient;
  /** 這一行在食譜裡的用量與成本，例如「500 g・$12.50」 */
  lineInfo?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [entry, setEntry] = useState(() => defaultPriceEntry(ingredient));
  const [date, setDate] = useState(todayIso());
  const current = priceDisplay(ingredient);
  const preview = entry.price.trim() ? entryUnitPrice(ingredient, entry) : null;
  const save = useAction(() =>
    rpc('batch_add_purchase_prices', {
      p: {
        effective_date: date,
        items: [{ ingredient_id: ingredient.id, pack_qty: toNum(entry.qty), pack_unit: entry.unit, price: toNum(entry.price) }],
      },
    }),
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={`單價：${ingredient.name}`}
      footer={
        <Button
          block
          disabled={!preview || !date}
          loading={save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: () => (toast(`已更新「${ingredient.name}」的單價`), onClose()) })}
        >
          儲存單價
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-stone-50 px-3 py-2">
          <div className="text-xs text-muted">目前單價</div>
          <div className={cx('font-semibold tabular-nums', current.missing && 'text-amber-800')}>{current.text}</div>
        </div>
        {lineInfo && (
          <div className="rounded-xl bg-stone-50 px-3 py-2">
            <div className="text-xs text-muted">這道食譜用到</div>
            <div className="font-semibold tabular-nums">{lineInfo}</div>
          </div>
        )}
      </div>

      <Field label="這次進貨" hint="包裝數量和單位先帶入目前的預設規格；金額是這個包裝實際付的錢（含稅）">
        {(id) => (
          <div className="flex gap-2">
            <NumberInput
              id={id}
              aria-label="包裝數量"
              value={entry.qty}
              onChange={(qty) => setEntry({ ...entry, qty })}
              className="w-20"
              placeholder="數量"
            />
            <Select aria-label="單位" value={entry.unit} onChange={(e) => setEntry({ ...entry, unit: e.target.value })} className="w-24">
              {compatibleUnits(ingredient, entry.unit).map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u)}
                </option>
              ))}
            </Select>
            <NumberInput
              aria-label="金額"
              value={entry.price}
              onChange={(price) => setEntry({ ...entry, price })}
              className="flex-1"
              placeholder="金額 $"
              autoFocus
            />
          </div>
        )}
      </Field>
      {entry.price.trim() &&
        (preview ? (
          <p className="text-sm font-medium text-brand-800 tabular-nums">新的單價 {preview}</p>
        ) : (
          <Notice tone="danger">包裝數量或單位不對，換算不出單價</Notice>
        ))}
      <Field label="生效日">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      <Link to={`/ingredients/${ingredient.id}`} className="inline-block min-h-11 py-2 text-sm text-brand-700">
        原物料詳情（包裝規格、損耗率、專屬單位）→
      </Link>
    </Sheet>
  );
}
