import { Archive, ChevronRight, Copy, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useRole } from '../app/auth';
import { RequireRole } from '../app/Layout';
import { useCosts } from '../app/costing';
import { formatDate, formatScore, todayIso, toNum } from '../app/format';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Loading,
  NumberInput,
  PageHeader,
  Section,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type { RecipeDetail } from '../data/types';
import { formatPercent, formatPrice, formatServingCost } from '../domain/format';
import type { ComponentKind } from '../domain/types';
import { COMPONENT_KIND_LABEL, RECIPE_TYPE_LABEL } from '../i18n/labels';

export function RecipeDetailPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <RecipeDetailView />
    </RequireRole>
  );
}

function RecipeDetailView() {
  const { id = '' } = useParams();
  const role = useRole();
  const navigate = useNavigate();
  const toast = useToast();
  const recipe = useRpc<RecipeDetail>('get_recipe', { p_id: id });
  const [editing, setEditing] = useState(false);
  const [pricing, setPricing] = useState(false);

  const r = recipe.data;
  const locked = r?.versions.find((v) => v.status === 'locked');
  const latest = r?.versions[0];
  const costs = useCosts(locked ? [locked.id] : latest ? [latest.id] : []);
  const view = costs.views?.get(locked?.id ?? latest?.id ?? '');

  const copy = useAction((sourceId: string) => rpc<string>('copy_version', { p_source_id: sourceId, p_change_note: '' }));
  const archive = useAction((archived: boolean) => rpc('set_recipe_archived', { p_id: id, p_archived: archived }));

  if (recipe.isLoading) return <Loading />;
  if (recipe.error || !r) return <ErrorState error={recipe.error} onRetry={() => recipe.refetch()} />;

  const copySource = locked ?? latest;

  return (
    <div className="space-y-6">
      <PageHeader
        back="/recipes"
        title={r.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{r.code}</span>
            <Badge>{RECIPE_TYPE_LABEL[r.type]}</Badge>
            <span>{r.type === 'component' ? COMPONENT_KIND_LABEL[r.component_kind as ComponentKind] : r.menu_category || '未分類'}</span>
            {r.is_archived && <Badge tone="warn">已封存</Badge>}
          </span>
        }
        actions={
          can.editRecipes(role) && (
            <Button small variant="secondary" onClick={() => setEditing(true)} aria-label="編輯基本資料">
              <Pencil className="size-4" aria-hidden />
              編輯
            </Button>
          )
        }
      />

      {r.description && <p className="text-muted">{r.description}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card>
          <div className="text-xs text-muted">現行版本</div>
          <div className="text-lg font-semibold">{locked ? `v${locked.version_no}` : '尚未定版'}</div>
        </Card>
        <Card>
          <div className="text-xs text-muted">每份成本{locked ? '' : `（v${latest?.version_no}）`}</div>
          <div className="text-lg font-semibold tabular-nums">
            {view ? (view.cost.isComplete ? `$${formatServingCost(view.cost.servingCost)}` : '不完整') : '—'}
          </div>
        </Card>
        {r.type === 'dish' && (
          <>
            <Card>
              <div className="text-xs text-muted">售價（含稅）</div>
              <div className="text-lg font-semibold tabular-nums">{r.current_price ? `$${r.current_price.price}` : '未設定'}</div>
            </Card>
            <Card>
              <div className="text-xs text-muted">食材成本率</div>
              <div className="text-lg font-semibold tabular-nums">{formatPercent(view?.metrics.foodCostRate ?? null)}</div>
              {view?.metrics.suggestedPrice && (
                <div className="text-xs text-muted">建議售價 ${formatPrice(view.metrics.suggestedPrice)}</div>
              )}
            </Card>
          </>
        )}
      </div>

      <Section
        title="版本"
        action={
          can.editRecipes(role) &&
          copySource && (
            <Button
              small
              variant="secondary"
              loading={copy.isPending}
              onClick={() =>
                copy.mutate(copySource.id, {
                  onSuccess: (newId) => {
                    toast(`已從 v${copySource.version_no} 複製出新草案`);
                    navigate(`/versions/${newId}/edit`);
                  },
                  onError: (e) => toast(e.message, 'danger'),
                })
              }
            >
              <Copy className="size-4" aria-hidden />從 v{copySource.version_no} 建立新版本
            </Button>
          )
        }
      >
        <div className="space-y-2">
          {r.versions.map((v) => (
            <Link key={v.id} to={`/versions/${v.id}`} className="block">
              <Card className="flex items-center gap-3 py-3 hover:bg-brand-50">
                <div className="w-10 shrink-0 text-lg font-bold text-brand-700">v{v.version_no}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{v.title || v.change_note || '（無標題）'}</div>
                  <div className="text-sm text-muted">
                    {v.status === 'locked' && v.approved_at
                      ? `${formatDate(v.approved_at)} 由 ${v.approved_by_name ?? '—'} 核准`
                      : v.status === 'retired'
                        ? `${formatDate(v.retired_at)} 停用${v.retire_reason ? `：${v.retire_reason}` : ''}`
                        : `${formatDate(v.created_at)} 建立${v.based_on_version_no ? `・複製自 v${v.based_on_version_no}` : ''}`}
                    {v.feedback_count > 0 && `・${v.feedback_count} 筆評分，平均 ${formatScore(v.avg_overall)}`}
                  </div>
                </div>
                <StatusBadge status={v.status} />
                <ChevronRight className="size-5 shrink-0 text-stone-400" aria-hidden />
              </Card>
            </Link>
          ))}
        </div>
        {r.versions.length >= 2 && (
          <Link to={`/compare?a=${r.versions[1].id}&b=${r.versions[0].id}`} className="inline-block min-h-11 py-2 text-brand-700">
            比較 v{r.versions[1].version_no} 與 v{r.versions[0].version_no} →
          </Link>
        )}
      </Section>

      {r.type === 'dish' && (
        <Section
          title="售價歷史"
          action={
            can.setPrice(role) && (
              <Button small variant="secondary" onClick={() => setPricing(true)}>
                設定售價
              </Button>
            )
          }
        >
          {r.menu_prices.length === 0 ? (
            <p className="text-sm text-muted">尚未設定售價{can.setPrice(role) ? '' : '（由創辦人設定）'}</p>
          ) : (
            <Card className="divide-y divide-line py-0">
              {r.menu_prices.map((p) => (
                <div key={p.id} className="flex justify-between gap-2 py-2.5 text-sm">
                  <span>{formatDate(p.effective_date)} 起</span>
                  <span className="font-semibold tabular-nums">${p.price}</span>
                  <span className="text-muted">{p.note || p.created_by_name}</span>
                </div>
              ))}
            </Card>
          )}
        </Section>
      )}

      {r.type === 'component' && (
        <Section title="被哪些食譜使用">
          {r.used_by.length === 0 ? (
            <p className="text-sm text-muted">還沒有被引用</p>
          ) : (
            <div className="space-y-2">
              {r.used_by.map((u) => (
                <Link key={`${u.version_id}-${u.component_version_id}`} to={`/versions/${u.version_id}`} className="block">
                  <Card className="flex items-center gap-2 py-3 text-sm hover:bg-brand-50">
                    <span className="flex-1">
                      {u.recipe_name} v{u.version_no}
                      <span className="text-muted">・使用本元件 v{u.component_version_no}</span>
                    </span>
                    {u.component_status === 'retired' && <Badge tone="warn">引用舊版</Badge>}
                    <StatusBadge status={u.status} />
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </Section>
      )}

      {can.editRecipes(role) && (
        <Button
          variant="ghost"
          loading={archive.isPending}
          onClick={() =>
            archive.mutate(!r.is_archived, {
              onSuccess: () => toast(r.is_archived ? '已取消封存' : '已封存'),
              onError: (e) => toast(e.message, 'danger'),
            })
          }
        >
          <Archive className="size-4" aria-hidden />
          {r.is_archived ? '取消封存' : '封存這個食譜'}
        </Button>
      )}

      {editing && <EditRecipeSheet recipe={r} open onClose={() => setEditing(false)} />}
      {pricing && <MenuPriceSheet recipeId={r.id} open onClose={() => setPricing(false)} suggested={view?.metrics.suggestedPrice?.toString()} />}
    </div>
  );
}

function EditRecipeSheet({ recipe, open, onClose }: { recipe: RecipeDetail; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(recipe.name);
  const [description, setDescription] = useState(recipe.description);
  const [category, setCategory] = useState(recipe.menu_category);
  const [kind, setKind] = useState<ComponentKind>(recipe.component_kind ?? 'other');
  const [target, setTarget] = useState(recipe.target_food_cost_rate ? String(Number(recipe.target_food_cost_rate) * 100) : '');
  const save = useAction((p: Record<string, unknown>) => rpc('update_recipe', { p_id: recipe.id, p }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="編輯基本資料"
      footer={
        <Button
          block
          loading={save.isPending}
          onClick={() => {
            const t = toNum(target);
            save.mutate(
              {
                name,
                description,
                menu_category: category,
                component_kind: kind,
                target_food_cost_rate: t === null ? '' : t / 100,
              },
              { onSuccess: () => (toast('已儲存'), onClose()), onError: (e) => toast(e.message, 'danger') },
            );
          }}
        >
          儲存
        </Button>
      }
    >
      <p className="text-sm text-muted">基本資料不屬於版本內容，修改後所有版本都會顯示新名稱（會留下操作紀錄）。</p>
      <Field label="名稱">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      {recipe.type === 'dish' ? (
        <>
          <Field label="菜單分類">{(id) => <Input id={id} value={category} onChange={(e) => setCategory(e.target.value)} />}</Field>
          <Field label="目標食材成本率（%）" hint="留空時使用系統設定">
            {(id) => <NumberInput id={id} value={target} onChange={setTarget} placeholder="例如 35" />}
          </Field>
        </>
      ) : (
        <Field label="元件分類">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ComponentKind)}>
              {Object.entries(COMPONENT_KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="說明">{(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </Sheet>
  );
}

function MenuPriceSheet({ recipeId, open, onClose, suggested }: { recipeId: string; open: boolean; onClose: () => void; suggested?: string }) {
  const toast = useToast();
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const save = useAction(() =>
    rpc('set_menu_price', { p_recipe_id: recipeId, p_price: toNum(price), p_effective_date: date, p_note: note }),
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="設定售價"
      footer={
        <Button
          block
          loading={save.isPending}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: () => {
                toast('已設定售價');
                setPrice('');
                onClose();
              },
              onError: (e) => toast(e.message, 'danger'),
            })
          }
        >
          儲存
        </Button>
      }
    >
      <Field label="含稅售價（元）" hint={suggested ? `建議售價 $${suggested}` : undefined}>
        {(id) => <NumberInput id={id} value={price} onChange={setPrice} placeholder="例如 160" />}
      </Field>
      <Field label="生效日">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      <Field label="備註（選填）">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </Sheet>
  );
}
