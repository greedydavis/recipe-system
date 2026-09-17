import { AlertTriangle, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { can, useRole } from '../app/auth';
import { RequireRole } from '../app/Layout';
import { useCosts } from '../app/costing';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  StatusBadge,
  Tabs,
  Textarea,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type { RecipeListItem } from '../data/types';
import { formatPercent, formatServingCost } from '../domain/format';
import type { ComponentKind, RecipeType } from '../domain/types';
import { COMPONENT_KIND_LABEL } from '../i18n/labels';

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function RecipesPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <RecipeList />
    </RequireRole>
  );
}

function RecipeList() {
  const role = useRole();
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') as RecipeType) || 'dish';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q);

  const list = useRpc<RecipeListItem[]>('list_recipes', { p_type: type, p_q: debounced || null, p_include_archived: archived });
  const versionIds = useMemo(() => (list.data ?? []).map((r) => r.locked?.id ?? r.latest.id), [list.data]);
  const costs = useCosts(versionIds);

  const groups = useMemo(() => {
    const map = new Map<string, RecipeListItem[]>();
    for (const r of list.data ?? []) {
      const key = r.type === 'dish' ? r.menu_category || '未分類' : COMPONENT_KIND_LABEL[r.component_kind as ComponentKind];
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [list.data]);

  return (
    <div>
      <PageHeader
        title="食譜"
        actions={
          can.editRecipes(role) && (
            <Button small onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              新增
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { key: 'dish', label: '菜品' },
          { key: 'component', label: '元件（湯底／醬料／配料）' },
        ]}
        value={type}
        onChange={(t) => setParams({ type: t })}
      />
      <div className="space-y-2">
        <SearchInput value={q} onChange={setQ} placeholder="搜尋名稱、編號、分類或使用的原物料" />
        <Checkbox checked={archived} onChange={setArchived} label="顯示已封存" />
      </div>

      <div className="mt-2 space-y-6">
        {list.isLoading && <Loading />}
        {list.error && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
        {list.data && list.data.length === 0 && (
          <EmptyState title={q ? '找不到符合的食譜' : `還沒有${type === 'dish' ? '菜品' : '元件'}`}>
            {can.editRecipes(role) && !q && '按右上角「新增」建立第一個。'}
          </EmptyState>
        )}
        {groups.map(([group, recipes]) => (
          <section key={group} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted">
              {group}（{recipes.length}）
            </h2>
            {recipes.map((r) => {
              const vid = r.locked?.id ?? r.latest.id;
              const view = costs.views?.get(vid);
              return (
                <Link key={r.id} to={`/recipes/${r.id}`} className="block">
                  <Card className="flex items-center gap-3 py-3 hover:bg-brand-50">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{r.name}</span>
                        {r.is_archived && <Badge>已封存</Badge>}
                        {r.has_outdated_components && (
                          <Badge tone="warn">
                            <AlertTriangle className="mr-0.5 size-3" aria-hidden />
                            元件已更新
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted">
                        <span>{r.code}</span>
                        <span>
                          {r.locked ? `現行 v${r.locked.version_no}` : '尚未定版'}
                          {r.latest.version_no !== r.locked?.version_no && `・最新 v${r.latest.version_no}`}
                        </span>
                        {view && (
                          <span className="tabular-nums">
                            {view.cost.isComplete ? `每份 $${formatServingCost(view.cost.servingCost)}` : '成本不完整'}
                            {r.type === 'dish' && view.metrics.foodCostRate && `・${formatPercent(view.metrics.foodCostRate)}`}
                          </span>
                        )}
                        {r.current_price && <span>售價 ${r.current_price.price}</span>}
                      </div>
                    </div>
                    <StatusBadge status={r.locked ? 'locked' : r.latest.status} />
                    <ChevronRight className="size-5 shrink-0 text-stone-400" aria-hidden />
                  </Card>
                </Link>
              );
            })}
          </section>
        ))}
      </div>

      <NewRecipeSheet open={creating} onClose={() => setCreating(false)} defaultType={type} />
    </div>
  );
}

function NewRecipeSheet({ open, onClose, defaultType }: { open: boolean; onClose: () => void; defaultType: RecipeType }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [type, setType] = useState<RecipeType>(defaultType);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind>('soup');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const categories = useRpc<RecipeListItem[]>('list_recipes', { p_type: 'dish', p_q: null, p_include_archived: true }, { enabled: open });

  useEffect(() => {
    if (open) setType(defaultType);
  }, [open, defaultType]);

  const create = useAction((p: Record<string, unknown>) => rpc<{ recipe_id: string; version_id: string }>('create_recipe', { p }));
  const categoryOptions = [...new Set((categories.data ?? []).map((r) => r.menu_category).filter(Boolean))];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="新增食譜"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            block
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { type, name, component_kind: type === 'component' ? kind : null, menu_category: type === 'dish' ? category : '', description },
                {
                  onSuccess: (r) => {
                    toast('已建立 v1 草案');
                    onClose();
                    setName('');
                    setDescription('');
                    navigate(`/versions/${r.version_id}/edit`);
                  },
                  onError: (e) => toast(e.message, 'danger'),
                },
              )
            }
          >
            建立並編輯 v1 草案
          </Button>
        </>
      }
    >
      <Field label="類型">
        {(id) => (
          <Select id={id} value={type} onChange={(e) => setType(e.target.value as RecipeType)}>
            <option value="dish">菜品（賣給客人的品項）</option>
            <option value="component">元件（湯底、醬料、配料等半成品）</option>
          </Select>
        )}
      </Field>
      <Field label="名稱">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
      {type === 'component' ? (
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
      ) : (
        <Field label="菜單分類" hint="例如：湯麵、拌麵、小菜、飲品">
          {(id) => (
            <>
              <Input id={id} list="menu-categories" value={category} onChange={(e) => setCategory(e.target.value)} />
              <datalist id="menu-categories">
                {categoryOptions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      )}
      <Field label="說明（選填）">{(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </Sheet>
  );
}
