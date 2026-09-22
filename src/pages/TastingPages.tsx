import { ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useMe, useRole } from '../app/auth';
import { formatDate, formatScore, formatSigned, todayIso } from '../app/format';
import { RequireRole } from '../app/Layout';
import { PhotoStrip } from '../components/photos';
import {
  Badge,
  BottomBar,
  Button,
  Card,
  Checkbox,
  ChipGroup,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LinkButton,
  Loading,
  Notice,
  PageHeader,
  SearchInput,
  Section,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type {
  Feedback,
  MyTastingTask,
  RecipeDetail,
  RecipeListItem,
  TastingItemDetail,
  TastingSessionDetail,
  TastingSessionListItem,
  TeamMember,
} from '../data/types';
import { isReferenceable } from '../domain/status';
import { MENU_READY_LABEL, OILINESS_LABELS, ROLE_LABEL, SALTINESS_LABELS } from '../i18n/labels';

// ───────────────────────── 列表 ─────────────────────────

export function TastingsPage() {
  const role = useRole();
  const tasks = useRpc<MyTastingTask[]>('get_my_tasting_tasks');
  const sessions = useRpc<TastingSessionListItem[]>('list_tasting_sessions', {}, { enabled: can.runTasting(role) });

  return (
    <div className="space-y-6">
      <PageHeader
        title="試菜"
        actions={
          can.runTasting(role) && (
            <LinkButton to="/tastings/new" variant="primary" small>
              <Plus className="size-4" aria-hidden />
              建立場次
            </LinkButton>
          )
        }
      />

      <Section title="指派給我的評分">
        {tasks.isLoading && <Loading />}
        {tasks.data && tasks.data.length === 0 && <EmptyState title="目前沒有指派給你的試吃項目" />}
        <div className="space-y-2">
          {tasks.data?.map((t) => (
            <Link key={t.item_id} to={`/tasting-items/${t.item_id}/feedback`} className="block">
              <Card className="flex items-center gap-3 hover:bg-brand-50">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{t.display_name}</div>
                  <div className="text-sm text-muted">
                    {formatDate(t.tasted_on)}・{t.session_title || '試菜'}
                  </div>
                </div>
                {t.my_feedback ? <Badge tone="ok">已評 {t.my_feedback.score_overall} 分</Badge> : <Badge tone="warn">待評分</Badge>}
                <ChevronRight className="size-5 text-stone-400" aria-hidden />
              </Card>
            </Link>
          ))}
        </div>
      </Section>

      {can.runTasting(role) && (
        <Section title="所有試菜場次">
          {sessions.isLoading && <Loading />}
          {sessions.error && <ErrorState error={sessions.error} />}
          {sessions.data && sessions.data.length === 0 && <EmptyState title="還沒有試菜場次" />}
          <div className="space-y-2">
            {sessions.data?.map((s) => (
              <Link key={s.id} to={`/tastings/${s.id}`} className="block">
                <Card className="flex items-center gap-3 hover:bg-brand-50">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">
                      {formatDate(s.tasted_on)} {s.title}
                    </div>
                    <div className="truncate text-sm text-muted">
                      {s.items.map((i) => `${i.recipe_name} v${i.version_no}${i.blind_label ? `（${i.blind_label}）` : ''}`).join('、')}
                    </div>
                  </div>
                  <Badge>{s.feedback_count} 筆評分</Badge>
                  <ChevronRight className="size-5 text-stone-400" aria-hidden />
                </Card>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ───────────────────────── 建立場次 ─────────────────────────

/** 試做項目的盲測代號、試做人與評分人員；建立場次與事後加入／修改都用這一組欄位 */
interface ItemAssignment {
  blind_label: string;
  maker_id: string;
  maker_name: string;
  assigned_tester_ids: string[];
}

interface NewItem extends ItemAssignment {
  key: string;
  version_id: string;
  label: string;
}

function assignmentPayload(a: ItemAssignment) {
  return {
    blind_label: a.blind_label,
    maker_id: a.maker_id || null,
    maker_name: a.maker_id ? '' : a.maker_name,
    assigned_tester_ids: a.assigned_tester_ids,
  };
}

function ItemAssignmentFields({
  value,
  onChange,
  team,
  blindPlaceholder,
}: {
  value: ItemAssignment;
  onChange: (value: ItemAssignment) => void;
  team: TeamMember[];
  blindPlaceholder?: string;
}) {
  const testers = team.filter((m) => m.role === 'tester');
  const others = team.filter((m) => m.role !== 'tester');
  const set = (patch: Partial<ItemAssignment>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="盲測代號（選填）" hint="填了之後測試人員只看得到代號">
          {(id) => (
            <Input id={id} value={value.blind_label} onChange={(e) => set({ blind_label: e.target.value })} placeholder={blindPlaceholder} />
          )}
        </Field>
        <Field label="試做人">
          {(id) => (
            <Select id={id} value={value.maker_id} onChange={(e) => set({ maker_id: e.target.value })}>
              <option value="">其他（手動輸入）</option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {!value.maker_id && (
        <Input
          aria-label="試做人姓名"
          placeholder="試做人姓名"
          value={value.maker_name}
          onChange={(e) => set({ maker_name: e.target.value })}
        />
      )}
      <fieldset>
        <legend className="text-sm font-medium">指派評分人員</legend>
        <div className="grid sm:grid-cols-2">
          {[...testers, ...others].map((m) => (
            <Checkbox
              key={m.id}
              label={`${m.display_name}（${ROLE_LABEL[m.role]}）`}
              checked={value.assigned_tester_ids.includes(m.id)}
              onChange={(checked) =>
                set({
                  assigned_tester_ids: checked
                    ? [...value.assigned_tester_ids, m.id]
                    : value.assigned_tester_ids.filter((t) => t !== m.id),
                })
              }
            />
          ))}
        </div>
      </fieldset>
    </>
  );
}

export function TastingNewPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <TastingNew />
    </RequireRole>
  );
}

function TastingNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const team = useRpc<TeamMember[]>('list_team_members');
  const [date, setDate] = useState(todayIso());
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<NewItem[]>([]);
  const [picking, setPicking] = useState(false);

  const create = useAction(() =>
    rpc<string>('create_tasting_session', {
      p: {
        tasted_on: date,
        title,
        location,
        note,
        items: items.map((i) => ({ version_id: i.version_id, ...assignmentPayload(i) })),
      },
    }),
  );

  const testers = (team.data ?? []).filter((m) => m.role === 'tester');

  return (
    <div className="space-y-6">
      <PageHeader back="/tastings" title="建立試菜場次" />
      <Card className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="試菜日期">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="地點">{(id) => <Input id={id} value={location} onChange={(e) => setLocation(e.target.value)} />}</Field>
        </div>
        <Field label="標題" hint="例如：第 1 輪｜兩大湯底方向">
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="備註">{(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </Card>

      <Section
        title={`試做項目（${items.length}）`}
        action={
          <Button small variant="secondary" onClick={() => setPicking(true)}>
            <Plus className="size-4" aria-hidden />
            加入版本
          </Button>
        }
      >
        {items.length === 0 && <EmptyState title="加入要試做的版本">可以放多個版本一起比較（例如湯底 v2 與 v3），並設定盲測代號。</EmptyState>}
        <div className="space-y-2">
          {items.map((item, index) => (
            <Card key={item.key} className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex-1 font-semibold">{item.label}</div>
                <button
                  type="button"
                  aria-label="移除"
                  onClick={() => setItems(items.filter((x) => x.key !== item.key))}
                  className="flex size-9 items-center justify-center rounded-lg text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <ItemAssignmentFields
                value={item}
                onChange={(v) => setItems(items.map((x, i) => (i === index ? { ...x, ...v } : x)))}
                team={team.data ?? []}
                blindPlaceholder={String.fromCharCode(65 + index)}
              />
            </Card>
          ))}
        </div>
      </Section>

      <BottomBar>
        <Button
          block
          disabled={items.length === 0}
          loading={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (id) => {
                toast('已建立試菜場次');
                navigate(`/tastings/${id}`, { replace: true });
              },
              onError: (e) => toast(e.message, 'danger'),
            })
          }
        >
          建立場次
        </Button>
      </BottomBar>

      {picking && (
        <VersionPicker
          onClose={() => setPicking(false)}
          exclude={items.map((i) => i.version_id)}
          onPick={(recipe, version) => {
            const testerIds = testers.map((t) => t.id);
            setItems([
              ...items,
              {
                key: crypto.randomUUID(),
                version_id: version.id,
                label: `${recipe.name} v${version.version_no}`,
                blind_label: '',
                maker_id: me.role === 'tester' ? '' : me.id,
                maker_name: '',
                assigned_tester_ids: items[items.length - 1]?.assigned_tester_ids ?? testerIds,
              },
            ]);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

function VersionPicker({
  onClose,
  onPick,
  exclude,
}: {
  onClose: () => void;
  onPick: (recipe: RecipeDetail, version: RecipeDetail['versions'][number]) => void;
  exclude: string[];
}) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRpc<RecipeListItem[]>('list_recipes', { p_type: null, p_q: null, p_include_archived: false });
  const detail = useRpc<RecipeDetail>('get_recipe', { p_id: selected }, { enabled: !!selected });
  const matches = (list.data ?? []).filter((r) => !q.trim() || r.name.includes(q.trim()));

  return (
    <Sheet open onClose={onClose} title={selected ? '選擇版本' : '選擇菜品或元件'}>
      {!selected ? (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="搜尋名稱" />
          <div className="divide-y divide-line">
            {matches.map((r) => (
              <button key={r.id} type="button" onClick={() => setSelected(r.id)} className="flex min-h-12 w-full items-center gap-2 py-2 text-left hover:bg-brand-50">
                <span className="flex-1">{r.name}</span>
                <span className="text-xs text-muted">{r.type === 'dish' ? '菜品' : '元件'}</span>
                <StatusBadge status={r.locked ? 'locked' : r.latest.status} />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <Button small variant="ghost" onClick={() => setSelected(null)}>
            ← 回到清單
          </Button>
          {detail.isLoading && <Loading />}
          <p className="text-sm text-muted">草案內容還會變動，必須先「送試菜」才能試做。</p>
          <div className="space-y-2">
            {detail.data?.versions.map((ver) => (
              <button
                key={ver.id}
                type="button"
                disabled={!isReferenceable(ver.status) || exclude.includes(ver.id)}
                onClick={() => onPick(detail.data!, ver)}
                className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2 text-left ring-1 ring-line hover:bg-brand-50 disabled:opacity-50"
              >
                <span className="font-semibold">v{ver.version_no}</span>
                <span className="flex-1 truncate text-sm">{ver.title}</span>
                <StatusBadge status={ver.status} />
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

// ───────────────────────── 場次詳情 ─────────────────────────

export function TastingSessionPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <TastingSession />
    </RequireRole>
  );
}

function TastingSession() {
  const { id = '' } = useParams();
  const me = useMe();
  const toast = useToast();
  const session = useRpc<TastingSessionDetail>('get_tasting_session', { p_id: id });
  const team = useRpc<TeamMember[]>('list_team_members');
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<{ versionId: string; label: string; assignment: ItemAssignment } | null>(null);

  const add = useAction((p: { versionId: string; assignment: ItemAssignment }) =>
    rpc('add_tasting_item', { p_session_id: id, p: { version_id: p.versionId, ...assignmentPayload(p.assignment) } }),
  );

  if (session.isLoading) return <Loading />;
  if (session.error || !session.data) return <ErrorState error={session.error} />;
  const s = session.data;

  return (
    <div className="space-y-6">
      <PageHeader
        back="/tastings"
        title={`${formatDate(s.tasted_on)} ${s.title}`}
        subtitle={[s.location, s.created_by_name && `建立者 ${s.created_by_name}`].filter(Boolean).join('・')}
        actions={
          <Button small onClick={() => setPicking(true)}>
            <Plus className="size-4" aria-hidden />
            加入項目
          </Button>
        }
      />
      {s.note && <Card className="text-sm whitespace-pre-wrap">{s.note}</Card>}
      {s.items.length > 1 && <ComparisonTable items={s.items} />}
      {s.items.length === 0 && <EmptyState title="這個場次還沒有試做項目">按右上角「加入項目」選要試做的版本。</EmptyState>}
      {s.items.map((item) => (
        <TastingItemCard key={item.id} item={item} team={team.data ?? []} />
      ))}

      {picking && (
        <VersionPicker
          exclude={s.items.map((i) => i.version_id)}
          onClose={() => setPicking(false)}
          onPick={(recipe, version) => {
            setPicking(false);
            const usesBlindLabels = s.items.some((i) => i.blind_label);
            setPending({
              versionId: version.id,
              label: `${recipe.name} v${version.version_no}`,
              assignment: {
                blind_label: usesBlindLabels ? String.fromCharCode(65 + s.items.length) : '',
                maker_id: me.role === 'tester' ? '' : me.id,
                maker_name: '',
                assigned_tester_ids:
                  s.items[0]?.assigned_testers.map((t) => t.id) ??
                  (team.data ?? []).filter((m) => m.role === 'tester').map((m) => m.id),
              },
            });
          }}
        />
      )}

      {pending && (
        <Sheet
          open
          title={`加入試做項目：${pending.label}`}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button
                block
                loading={add.isPending}
                onClick={() =>
                  add.mutate(
                    { versionId: pending.versionId, assignment: pending.assignment },
                    {
                      onSuccess: () => {
                        toast('已加入試做項目');
                        setPending(null);
                      },
                      onError: (e) => toast(e.message, 'danger'),
                    },
                  )
                }
              >
                加入
              </Button>
            </>
          }
        >
          <ItemAssignmentFields
            value={pending.assignment}
            onChange={(v) => setPending({ ...pending, assignment: v })}
            team={team.data ?? []}
            blindPlaceholder={String.fromCharCode(65 + s.items.length)}
          />
        </Sheet>
      )}
    </div>
  );
}

function ComparisonTable({ items }: { items: TastingItemDetail[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm tabular-nums">
        <thead className="bg-brand-50 text-left">
          <tr>
            <th className="px-3 py-2 font-medium">項目</th>
            <th className="px-3 py-2 text-right font-medium">整體</th>
            <th className="px-3 py-2 text-right font-medium">風味</th>
            <th className="px-3 py-2 text-right font-medium">口感</th>
            <th className="px-3 py-2 text-right font-medium">鹹淡</th>
            <th className="px-3 py-2 text-right font-medium">油膩</th>
            <th className="px-3 py-2 text-right font-medium">人數</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2">
                {i.recipe_name} v{i.version_no}
                {i.blind_label && <span className="text-muted">（{i.blind_label}）</span>}
              </td>
              <td className="px-3 py-2 text-right font-semibold">{formatScore(i.stats.avg_overall)}</td>
              <td className="px-3 py-2 text-right">{formatScore(i.stats.avg_flavor)}</td>
              <td className="px-3 py-2 text-right">{formatScore(i.stats.avg_texture)}</td>
              <td className="px-3 py-2 text-right">{formatSigned(i.stats.avg_saltiness)}</td>
              <td className="px-3 py-2 text-right">{formatSigned(i.stats.avg_oiliness)}</td>
              <td className="px-3 py-2 text-right">{i.stats.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function TastingItemCard({ item, team }: { item: TastingItemDetail; team: TeamMember[] }) {
  const role = useRole();
  const me = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deviation, setDeviation] = useState(item.deviation_note);
  const [proxy, setProxy] = useState(false);
  const [assignment, setAssignment] = useState<ItemAssignment | null>(null);

  const currentAssignment = (): ItemAssignment => ({
    blind_label: item.blind_label,
    maker_id: item.maker_id ?? '',
    maker_name: item.maker_name_text,
    assigned_tester_ids: item.assigned_testers.map((t) => t.id),
  });

  const saveDeviation = useAction(() =>
    rpc('update_tasting_item', {
      p_id: item.id,
      p: { deviation_note: deviation, ...assignmentPayload(currentAssignment()) },
    }),
  );
  const saveAssignment = useAction((value: ItemAssignment) =>
    rpc('update_tasting_item', { p_id: item.id, p: { deviation_note: item.deviation_note, ...assignmentPayload(value) } }),
  );
  const removeItem = useAction(() => rpc('delete_tasting_item', { p_id: item.id }));
  const newVersion = useAction(() => {
    const issues = item.feedback.map((f) => f.issues).filter(Boolean);
    const suggestions = item.feedback.map((f) => f.suggestions).filter(Boolean);
    const note = [
      `依 ${formatDate(new Date().toISOString())} 試菜回饋修改（v${item.version_no}，平均 ${formatScore(item.stats.avg_overall)} 分）`,
      issues.length ? `問題：${issues.join('／')}` : '',
      suggestions.length ? `建議：${suggestions.join('／')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return rpc<string>('copy_version', { p_source_id: item.version_id, p_change_note: note });
  });

  const assignedToMe = item.assigned_testers.some((t) => t.id === me.id);
  const myFeedback = item.feedback.find((f) => f.taster_id === me.id);

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/versions/${item.version_id}`} className="text-lg font-semibold hover:underline">
          {item.recipe_name} v{item.version_no}
        </Link>
        {item.blind_label && <Badge>盲測 {item.blind_label}</Badge>}
        <StatusBadge status={item.version_status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
        <span>
          試做人：{item.maker_name || '—'}・評分人員：{item.assigned_testers.map((t) => t.display_name).join('、') || '未指派'}
        </span>
        <Button small variant="ghost" onClick={() => setAssignment(currentAssignment())}>
          編輯指派
        </Button>
        {item.feedback.length === 0 && can.editRecipes(role) && (
          <Button
            small
            variant="ghost"
            loading={removeItem.isPending}
            onClick={() => {
              if (!confirm(`從這個場次移除「${item.recipe_name} v${item.version_no}」？`)) return;
              removeItem.mutate(undefined, { onSuccess: () => toast('已移除試做項目'), onError: (e) => toast(e.message, 'danger') });
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            移除
          </Button>
        )}
      </div>

      <PhotoStrip photos={item.photos} target={{ tasting_item_id: item.id }} canAdd canDelete={role === 'founder'} emptyText="還沒有試做照片" />

      {editing ? (
        <div className="space-y-2">
          <Textarea aria-label="實際做法偏差" value={deviation} onChange={(e) => setDeviation(e.target.value)} placeholder="例如：火力不足，多煮 5 分鐘；少放 2 g 鹽" />
          <div className="flex gap-2">
            <Button small variant="secondary" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              small
              loading={saveDeviation.isPending}
              onClick={() => saveDeviation.mutate(undefined, { onSuccess: () => (setEditing(false), toast('已儲存')), onError: (e) => toast(e.message, 'danger') })}
            >
              儲存
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className="block min-h-11 w-full rounded-xl bg-stone-50 px-3 py-2 text-left text-sm hover:bg-stone-100">
          <span className="font-medium">實際做法偏差：</span>
          {item.deviation_note || <span className="text-muted">（點此記錄）</span>}
        </button>
      )}

      <div className="flex flex-wrap gap-3 text-sm tabular-nums">
        <span>
          整體 <b>{formatScore(item.stats.avg_overall)}</b>
        </span>
        <span>鹹淡 {formatSigned(item.stats.avg_saltiness)}</span>
        <span>油膩 {formatSigned(item.stats.avg_oiliness)}</span>
        <span className="text-muted">
          上菜單：可 {item.stats.menu_ready_yes}／再調 {item.stats.menu_ready_maybe}／不 {item.stats.menu_ready_no}
        </span>
      </div>

      {item.feedback.length > 0 && (
        <div className="divide-y divide-line rounded-xl ring-1 ring-line">
          {item.feedback.map((f) => (
            <FeedbackRow key={f.id} f={f} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {assignedToMe && item.version_status !== 'retired' && (
          <LinkButton small to={`/tasting-items/${item.id}/feedback`} variant={myFeedback ? 'secondary' : 'primary'}>
            {myFeedback ? '修改我的評分' : '填寫我的評分'}
          </LinkButton>
        )}
        {item.version_status !== 'retired' && (
          <Button small variant="secondary" onClick={() => setProxy(true)}>
            代填外部評分
          </Button>
        )}
        {can.editRecipes(role) && (
          <Button
            small
            variant="secondary"
            loading={newVersion.isPending}
            onClick={() =>
              newVersion.mutate(undefined, {
                onSuccess: (newId) => {
                  toast('已依回饋建立新草案');
                  navigate(`/versions/${newId}/edit`);
                },
                onError: (e) => toast(e.message, 'danger'),
              })
            }
          >
            <Copy className="size-4" aria-hidden />
            依回饋建立新版本
          </Button>
        )}
      </div>
      {proxy && <ProxyFeedbackSheet itemId={item.id} onClose={() => setProxy(false)} />}
      {assignment && (
        <Sheet
          open
          title={`編輯指派：${item.recipe_name} v${item.version_no}`}
          onClose={() => setAssignment(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAssignment(null)}>
                取消
              </Button>
              <Button
                block
                loading={saveAssignment.isPending}
                onClick={() =>
                  saveAssignment.mutate(assignment, {
                    onSuccess: () => {
                      toast('已更新指派');
                      setAssignment(null);
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
          <ItemAssignmentFields value={assignment} onChange={setAssignment} team={team} />
        </Sheet>
      )}
    </Card>
  );
}

function FeedbackRow({ f }: { f: Feedback }) {
  return (
    <div className="px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{f.taster_display}</span>
        {!f.taster_id && <Badge>代填：{f.entered_by_name}</Badge>}
        <span className="tabular-nums">整體 {f.score_overall}</span>
        {f.score_flavor && <span className="text-muted">風味 {f.score_flavor}</span>}
        {f.score_texture && <span className="text-muted">口感 {f.score_texture}</span>}
        {f.saltiness !== null && <span className="text-muted">{SALTINESS_LABELS[f.saltiness + 2]}</span>}
        {f.oiliness !== null && <span className="text-muted">{OILINESS_LABELS[f.oiliness + 2]}</span>}
        {f.menu_ready && <Badge tone={f.menu_ready === 'yes' ? 'ok' : f.menu_ready === 'no' ? 'danger' : 'warn'}>{MENU_READY_LABEL[f.menu_ready]}</Badge>}
      </div>
      {f.issues && <p>問題：{f.issues}</p>}
      {f.suggestions && <p>建議：{f.suggestions}</p>}
    </div>
  );
}

function ProxyFeedbackSheet({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [form, setForm] = useState<FeedbackForm>(emptyForm());
  const submit = useAction(() => rpc('submit_feedback', { p_item_id: itemId, p: { ...form, taster_name: name } }));
  return (
    <Sheet
      open
      onClose={onClose}
      title="代填外部試吃者評分"
      footer={
        <Button
          block
          loading={submit.isPending}
          disabled={!name.trim() || !form.score_overall}
          onClick={() => submit.mutate(undefined, { onSuccess: () => (toast('已送出評分'), onClose()), onError: (e) => toast(e.message, 'danger') })}
        >
          送出
        </Button>
      }
    >
      <Field label="試吃者姓名">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <FeedbackFields form={form} onChange={setForm} />
    </Sheet>
  );
}

// ───────────────────────── 評分表單 ─────────────────────────

interface FeedbackForm {
  score_overall: number | null;
  score_flavor: number | null;
  score_texture: number | null;
  score_aroma: number | null;
  score_appearance: number | null;
  saltiness: number | null;
  oiliness: number | null;
  issues: string;
  suggestions: string;
  menu_ready: string | null;
}

function emptyForm(): FeedbackForm {
  return {
    score_overall: null,
    score_flavor: null,
    score_texture: null,
    score_aroma: null,
    score_appearance: null,
    saltiness: null,
    oiliness: null,
    issues: '',
    suggestions: '',
    menu_ready: null,
  };
}

const SCORE_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }));

function FeedbackFields({ form, onChange }: { form: FeedbackForm; onChange: (f: FeedbackForm) => void }) {
  const set = (patch: Partial<FeedbackForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="font-semibold">整體分數（必填）</div>
        <ChipGroup label="整體分數" value={form.score_overall} onChange={(v) => set({ score_overall: v })} options={SCORE_OPTIONS} />
        <p className="text-xs text-muted">1 不好吃・3 普通・5 非常好吃</p>
      </div>
      {(
        [
          ['score_flavor', '風味'],
          ['score_texture', '口感'],
          ['score_aroma', '香氣'],
          ['score_appearance', '外觀'],
        ] as const
      ).map(([key, label]) => (
        <div key={key} className="space-y-2">
          <div className="text-sm font-medium">{label}（選填）</div>
          <ChipGroup label={label} value={form[key]} onChange={(v) => set({ [key]: v })} options={SCORE_OPTIONS} allowClear />
        </div>
      ))}
      <div className="space-y-2">
        <div className="text-sm font-medium">鹹淡</div>
        <ChipGroup
          label="鹹淡"
          value={form.saltiness}
          onChange={(v) => set({ saltiness: v })}
          options={SALTINESS_LABELS.map((l, i) => ({ value: i - 2, label: l }))}
          allowClear
        />
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">油膩度</div>
        <ChipGroup
          label="油膩度"
          value={form.oiliness}
          onChange={(v) => set({ oiliness: v })}
          options={OILINESS_LABELS.map((l, i) => ({ value: i - 2, label: l }))}
          allowClear
        />
      </div>
      <Field label="問題">{(id) => <Textarea id={id} value={form.issues} onChange={(e) => set({ issues: e.target.value })} placeholder="例如：麵條偏軟、湯頭後段略淡" />}</Field>
      <Field label="修改建議">{(id) => <Textarea id={id} value={form.suggestions} onChange={(e) => set({ suggestions: e.target.value })} />}</Field>
      <div className="space-y-2">
        <div className="text-sm font-medium">能不能上菜單？</div>
        <ChipGroup
          label="能不能上菜單"
          value={form.menu_ready}
          onChange={(v) => set({ menu_ready: v })}
          options={Object.entries(MENU_READY_LABEL).map(([value, label]) => ({ value, label }))}
          allowClear
        />
      </div>
    </div>
  );
}

export function FeedbackPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const tasks = useRpc<MyTastingTask[]>('get_my_tasting_tasks');
  const task = useMemo(() => tasks.data?.find((t) => t.item_id === id), [tasks.data, id]);
  const [form, setForm] = useState<FeedbackForm | null>(null);

  const initial = useMemo<FeedbackForm | null>(() => {
    if (!task) return null;
    const f = task.my_feedback;
    return f
      ? {
          score_overall: f.score_overall,
          score_flavor: f.score_flavor,
          score_texture: f.score_texture,
          score_aroma: f.score_aroma,
          score_appearance: f.score_appearance,
          saltiness: f.saltiness,
          oiliness: f.oiliness,
          issues: f.issues,
          suggestions: f.suggestions,
          menu_ready: f.menu_ready,
        }
      : emptyForm();
  }, [task]);
  const current = form ?? initial;

  const submit = useAction((f: FeedbackForm) => rpc('submit_feedback', { p_item_id: id, p: f }));

  if (tasks.isLoading) return <Loading />;
  if (tasks.error) return <ErrorState error={tasks.error} />;
  if (!task || !current) {
    return (
      <div className="space-y-4">
        <PageHeader back="/tastings" title="評分" />
        <Notice tone="warn">找不到這個試吃項目，或它沒有指派給你。</Notice>
      </div>
    );
  }
  const locked = task.my_feedback ? !task.my_feedback.can_edit : !task.can_submit;

  return (
    <div className="space-y-5">
      <PageHeader back="/tastings" title={task.display_name} subtitle={`${formatDate(task.tasted_on)}・${task.session_title || '試菜'}`} />
      {task.photos.length > 0 && <PhotoStrip photos={task.photos} target={{ tasting_item_id: task.item_id }} canAdd={false} canDelete={false} large />}
      {locked ? (
        <Notice tone="info">版本已定版或停用，評分不能再修改。</Notice>
      ) : (
        <Card>
          <FeedbackFields form={current} onChange={setForm} />
        </Card>
      )}
      {!locked && (
        <BottomBar>
          <Button
            block
            disabled={!current.score_overall}
            loading={submit.isPending}
            onClick={() =>
              submit.mutate(current, {
                onSuccess: () => {
                  toast('已送出評分，謝謝！');
                  navigate('/tastings');
                },
                onError: (e) => toast(e.message, 'danger'),
              })
            }
          >
            {task.my_feedback ? '更新評分' : '送出評分'}
          </Button>
        </BottomBar>
      )}
    </div>
  );
}
