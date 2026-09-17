import { ChevronRight, Download, Upload } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { can, useAuth, useMe } from '../app/auth';
import { formatDateTime, toNum } from '../app/format';
import { RequireRole } from '../app/Layout';
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
  Notice,
  NumberInput,
  PageHeader,
  Section,
  Select,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import { type BaselineFile, importBaseline } from '../data/baselineImport';
import type { AuditLog, Profile, Settings } from '../data/types';
import type { Role } from '../domain/types';
import { ACTION_LABEL, ROLE_LABEL, TABLE_LABEL } from '../i18n/labels';

// ───────────────────────── 更多 ─────────────────────────

export function MorePage() {
  const me = useMe();
  const { backend, session, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me.display_name);
  const rename = useAction(async () => {
    await rpc('update_my_display_name', { p_name: name });
    await refresh();
  });

  const links: Array<{ to: string; label: string; show: boolean }> = [
    { to: '/suppliers', label: '供應商', show: can.editMaster(me.role) },
    { to: '/admin/users', label: '帳號與角色', show: can.admin(me.role) },
    { to: '/admin/settings', label: '系統設定（目標成本率、稅率）', show: can.viewKitchen(me.role) },
    { to: '/audit', label: '操作紀錄', show: can.viewAudit(me.role) },
    { to: '/admin/data', label: '資料匯出與匯入', show: can.admin(me.role) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="更多" />
      <Section title="我的帳號">
        <Card className="space-y-3">
          <div className="text-sm text-muted">
            {session?.email}・{ROLE_LABEL[me.role]}
          </div>
          <Field label="顯示名稱">
            {(id) => (
              <div className="flex gap-2">
                <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />
                <Button
                  variant="secondary"
                  disabled={name === me.display_name}
                  loading={rename.isPending}
                  onClick={() => rename.mutate(undefined, { onSuccess: () => toast('已更新名稱'), onError: (e) => toast(e.message, 'danger') })}
                >
                  儲存
                </Button>
              </div>
            )}
          </Field>
          <Button variant="secondary" block onClick={() => backend?.signOut()}>
            {backend?.mode === 'demo' ? '切換示範帳號' : '登出'}
          </Button>
        </Card>
      </Section>

      {links.some((l) => l.show) && (
        <Section title="管理">
          <Card className="divide-y divide-line py-0">
            {links
              .filter((l) => l.show)
              .map((l) => (
                <Link key={l.to} to={l.to} className="flex min-h-12 items-center justify-between py-3 hover:text-brand-700">
                  {l.label}
                  <ChevronRight className="size-5 text-stone-400" aria-hidden />
                </Link>
              ))}
          </Card>
        </Section>
      )}

      {backend?.mode === 'demo' && (
        <Section title="示範模式">
          <Card className="space-y-2">
            <p className="text-sm text-muted">資料只存在這台裝置的瀏覽器。重設會刪除所有示範資料並重新建立。</p>
            <Button variant="danger" onClick={() => confirm('確定要清除這台裝置上的所有示範資料？') && backend.resetDemo?.()}>
              重設示範資料
            </Button>
          </Card>
        </Section>
      )}
    </div>
  );
}

// ───────────────────────── 帳號與角色 ─────────────────────────

export function UsersPage() {
  return (
    <RequireRole roles={['founder']}>
      <Users />
    </RequireRole>
  );
}

function Users() {
  const me = useMe();
  const toast = useToast();
  const profiles = useRpc<Profile[]>('list_profiles');
  const assign = useAction(({ id, role }: { id: string; role: Role }) => rpc('assign_role', { p_user_id: id, p_role: role }));
  const setActive = useAction(({ id, active }: { id: string; active: boolean }) => rpc('set_profile_active', { p_user_id: id, p_active: active }));

  if (profiles.isLoading) return <Loading />;
  if (profiles.error) return <ErrorState error={profiles.error} />;
  const pending = (profiles.data ?? []).filter((p) => p.role === 'pending' && p.is_active);

  return (
    <div className="space-y-6">
      <PageHeader back="/more" title="帳號與角色" />
      {pending.length > 0 && <Notice tone="warn">有 {pending.length} 個新帳號等待指派角色。</Notice>}
      <Notice tone="info">新成員自行註冊後，在這裡指派角色才能使用。停用的帳號會立即失去所有權限。</Notice>
      <div className="space-y-2">
        {profiles.data?.map((p) => (
          <Card key={p.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{p.display_name}</span>
              {p.id === me.id && <Badge>我</Badge>}
              {!p.is_active && <Badge tone="danger">已停用</Badge>}
              {p.role === 'pending' && <Badge tone="warn">待審核</Badge>}
              <span className="text-xs text-muted">{formatDateTime(p.created_at)} 註冊</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={`${p.display_name} 的角色`}
                value={p.role}
                className="w-40"
                onChange={(e) =>
                  assign.mutate({ id: p.id, role: e.target.value as Role }, { onSuccess: () => toast('已更新角色'), onError: (err) => toast(err.message, 'danger') })
                }
              >
                {Object.entries(ROLE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              {p.id !== me.id && (
                <Button
                  small
                  variant={p.is_active ? 'danger' : 'secondary'}
                  onClick={() =>
                    setActive.mutate(
                      { id: p.id, active: !p.is_active },
                      { onSuccess: () => toast(p.is_active ? '已停用' : '已啟用'), onError: (err) => toast(err.message, 'danger') },
                    )
                  }
                >
                  {p.is_active ? '停用' : '啟用'}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── 系統設定 ─────────────────────────

export function SettingsPage() {
  return (
    <RequireRole roles={['founder', 'chef', 'manager']}>
      <SettingsForm />
    </RequireRole>
  );
}

function SettingsForm() {
  const me = useMe();
  const toast = useToast();
  const settings = useRpc<Settings>('get_settings');
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null);
  const editable = can.admin(me.role);

  const save = useAction((patch: Record<string, unknown>) => rpc('update_settings', { p_patch: patch }));

  if (settings.isLoading) return <Loading />;
  if (settings.error || !settings.data) return <ErrorState error={settings.error} />;
  const s = settings.data;
  const values = draft ?? {
    target: String(Number(s.target_food_cost_rate) * 100),
    tax: String(Number(s.sales_tax_rate) * 100),
    round: String(s.price_round_to),
    requireTasting: s.require_tasting_before_approval,
  };
  const set = (k: string, v: string | boolean) => setDraft({ ...values, [k]: v });

  return (
    <div className="space-y-6">
      <PageHeader back="/more" title="系統設定" />
      {!editable && <Notice tone="info">只有創辦人可以修改設定。</Notice>}
      <Card className="space-y-4">
        <Field label="目標食材成本率（%）" hint="建議售價 = 每份成本 ÷ 目標食材成本率 ×（1 + 營業稅率）；菜品可以個別覆寫">
          {(id) => <NumberInput id={id} value={values.target as string} onChange={(v) => set('target', v)} disabled={!editable} />}
        </Field>
        <Field label="營業稅率（%）" hint="菜單售價視為含稅；食材成本率以未稅售價計算。小規模營業人請和會計確認">
          {(id) => <NumberInput id={id} value={values.tax as string} onChange={(v) => set('tax', v)} disabled={!editable} />}
        </Field>
        <Field label="建議售價進位到（元）" hint="無條件進位到這個數字的倍數">
          {(id) => <NumberInput id={id} value={values.round as string} onChange={(v) => set('round', v)} disabled={!editable} />}
        </Field>
        <Checkbox
          checked={values.requireTasting as boolean}
          onChange={(v) => set('requireTasting', v)}
          disabled={!editable}
          label="試菜中的版本送核准前，必須至少有一筆試吃評分"
        />
        {editable && (
          <Button
            block
            disabled={!draft}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  target_food_cost_rate: (toNum(values.target as string) ?? 0) / 100,
                  sales_tax_rate: (toNum(values.tax as string) ?? 0) / 100,
                  price_round_to: toNum(values.round as string) ?? 0,
                  require_tasting_before_approval: values.requireTasting,
                },
                { onSuccess: () => (setDraft(null), toast('已儲存設定')), onError: (e) => toast(e.message, 'danger') },
              )
            }
          >
            儲存設定
          </Button>
        )}
      </Card>
    </div>
  );
}

// ───────────────────────── 操作紀錄 ─────────────────────────

export function AuditPage() {
  return (
    <RequireRole roles={['founder', 'chef']}>
      <Audit />
    </RequireRole>
  );
}

function Audit() {
  const [params] = useSearchParams();
  const [table, setTable] = useState(params.get('table') ?? '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [before, setBefore] = useState<number[]>([]);
  const record = params.get('record') ?? '';
  const filters = { table_name: table, record_id: record, date_from: dateFrom, date_to: dateTo, before_id: before[before.length - 1] ?? '', limit: 50 };
  const logs = useRpc<{ items: AuditLog[]; next_before_id: number | null }>('list_audit_logs', { p: filters });

  return (
    <div className="space-y-4">
      <PageHeader back="/more" title="操作紀錄" subtitle={record ? `只顯示單一紀錄 ${record.slice(0, 8)}…` : '所有重要修改都會自動記錄，無法修改或刪除'} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Select aria-label="資料類型" value={table} onChange={(e) => (setTable(e.target.value), setBefore([]))} className="col-span-2 sm:col-span-1">
          <option value="">全部資料類型</option>
          {Object.entries(TABLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Input aria-label="開始日期" type="date" value={dateFrom} onChange={(e) => (setDateFrom(e.target.value), setBefore([]))} />
        <Input aria-label="結束日期" type="date" value={dateTo} onChange={(e) => (setDateTo(e.target.value), setBefore([]))} />
      </div>
      {logs.isLoading && <Loading />}
      {logs.error && <ErrorState error={logs.error} />}
      {logs.data && logs.data.items.length === 0 && <EmptyState title="沒有紀錄" />}
      <div className="space-y-2">
        {logs.data?.items.map((log) => (
          <AuditRow key={log.id} log={log} />
        ))}
      </div>
      <div className="flex justify-between">
        <Button variant="secondary" disabled={before.length === 0} onClick={() => setBefore(before.slice(0, -1))}>
          較新
        </Button>
        <Button variant="secondary" disabled={!logs.data?.next_before_id} onClick={() => logs.data?.next_before_id && setBefore([...before, logs.data.next_before_id])}>
          較舊
        </Button>
      </div>
    </div>
  );
}

const HIDDEN_FIELDS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'revision', 'detail']);

function showValue(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-muted">（空）</span>;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

function AuditRow({ log }: { log: AuditLog }) {
  const [open, setOpen] = useState(false);
  const data = log.new_data ?? log.old_data ?? {};
  const label = (data.name ?? data.display_name ?? data.title ?? data.spec_name ?? data.unit_name ?? '') as string;
  const fields =
    log.action === 'update'
      ? (log.changed_fields ?? []).filter((f) => !HIDDEN_FIELDS.has(f))
      : Object.keys(data).filter((f) => !HIDDEN_FIELDS.has(f));
  return (
    <Card className="py-3 text-sm">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Badge tone={log.action === 'delete' ? 'danger' : log.action === 'insert' ? 'ok' : 'info'}>{ACTION_LABEL[log.action]}</Badge>
        <span className="font-medium">{TABLE_LABEL[log.table_name] ?? log.table_name}</span>
        {label && <span className="truncate">「{label}」</span>}
        {log.action === 'update' && fields.length > 0 && <span className="text-muted">改了 {fields.length} 個欄位</span>}
        <span className="ml-auto text-xs text-muted">
          {log.actor_name ?? '系統'}・{formatDateTime(log.occurred_at)}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1 rounded-lg bg-stone-50 p-2">
          {fields.map((f) => (
            <div key={f} className="grid grid-cols-[8rem_1fr] gap-2 break-all">
              <span className="text-muted">{f}</span>
              <span>
                {log.action === 'update' ? (
                  <>
                    {showValue(log.old_data?.[f])} → <b>{showValue(log.new_data?.[f])}</b>
                  </>
                ) : (
                  showValue(data[f])
                )}
              </span>
            </div>
          ))}
          {log.context && <div className="text-xs text-muted">操作：{log.context}</div>}
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── 資料匯出與匯入 ─────────────────────────

export function DataPage() {
  return (
    <RequireRole roles={['founder']}>
      <DataTools />
    </RequireRole>
  );
}

function DataTools() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function exportAll() {
    try {
      const data = await rpc<unknown>('export_all');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `試菜與標準食譜系統_備份_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('已下載備份');
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  }

  async function runImport(file: BaselineFile) {
    setBusy(true);
    setLog([]);
    try {
      await importBaseline(file, (line) => setLog((xs) => [...xs, line]));
      toast('匯入完成');
    } catch (e) {
      setLog((xs) => [...xs, `❌ ${(e as Error).message}`]);
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader back="/more" title="資料匯出與匯入" />
      <Section title="備份">
        <Card className="space-y-2">
          <p className="text-sm text-muted">下載所有資料（含操作紀錄）的 JSON 檔。建議每週備份一次，存放在安全的地方。</p>
          <Button onClick={exportAll}>
            <Download className="size-4" aria-hidden />
            下載全部資料
          </Button>
        </Card>
      </Section>

      <Section title="匯入基準版菜單">
        <Card className="space-y-3">
          <p className="text-sm text-muted">
            匯入由 <code>scripts/import_baseline.py</code> 從《餐廳菜單_完整試作與配方表》產生的 JSON。已存在的同名原物料與食譜會略過，不會覆蓋。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy} onClick={() => fileInput.current?.click()}>
              <Upload className="size-4" aria-hidden />
              選擇 JSON 檔
            </Button>
            {import.meta.env.DEV && (
              <Button
                variant="secondary"
                loading={busy}
                onClick={async () => {
                  const res = await fetch('/private/baseline-seed.json');
                  if (!res.ok) return toast('找不到 private/baseline-seed.json，請先執行 npm run seed:baseline', 'danger');
                  await runImport((await res.json()) as BaselineFile);
                }}
              >
                從 private/baseline-seed.json 匯入（開發模式）
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) await runImport(JSON.parse(await f.text()) as BaselineFile);
            }}
          />
          {log.length > 0 && (
            <pre className="max-h-80 overflow-auto rounded-lg bg-stone-900 p-3 text-xs whitespace-pre-wrap text-stone-100">{log.join('\n')}</pre>
          )}
        </Card>
      </Section>
    </div>
  );
}
