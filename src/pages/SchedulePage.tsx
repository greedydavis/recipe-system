import { useQueryClient } from '@tanstack/react-query';
import { Check, Move, Plus } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { formatDate, todayIso } from '../app/format';
import {
  Badge,
  Button,
  Checkbox,
  ChipGroup,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  PageHeader,
  Sheet,
  Textarea,
  cx,
  useToast,
} from '../components/ui';
import { rpc, useAction, useRpc } from '../data/api';
import type { ScheduleTask } from '../data/types';
import {
  type DateRange,
  type DragMode,
  addDays,
  applyDrag,
  dayNumber,
  durationDays,
  monthSegments,
  taskState,
  weekday,
} from '../domain/schedule';

/** 時間線的起點（使用者指定） */
export const SCHEDULE_START = '2026-09-01';
const CATEGORY_HINTS = ['裝潢', '設備', '證照與行政', '人事', '菜單研發', '行銷', '其他'];
const BAR_COLORS = ['bg-brand-600', 'bg-sky-600', 'bg-emerald-600', 'bg-amber-600', 'bg-violet-600', 'bg-rose-600', 'bg-teal-600', 'bg-stone-500'];
const UNCATEGORIZED = '未分類';

type Zoom = 'week' | 'month';
const DAY_WIDTH: Record<Zoom, number> = { week: 26, month: 9 };

interface Drag {
  id: string;
  mode: DragMode;
  startX: number;
  origin: DateRange;
  range: DateRange;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}

function rangeText(range: DateRange): string {
  return `${shortDate(range.start_date)}–${shortDate(range.end_date)}（${durationDays(range)} 天）`;
}

export function SchedulePage() {
  const toast = useToast();
  const client = useQueryClient();
  const tasks = useRpc<ScheduleTask[]>('list_schedule_tasks');
  const [zoom, setZoom] = useState<Zoom>('week');
  // 滑鼠可以直接拖；手機預設關閉，避免左右捲動時不小心拖到
  const [adjusting, setAdjusting] = useState(() => window.matchMedia('(pointer: fine)').matches);
  const [editing, setEditing] = useState<ScheduleTask | 'new' | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledToToday = useRef(false);

  const today = todayIso();
  const dayWidth = DAY_WIDTH[zoom];
  const list = useMemo(() => tasks.data ?? [], [tasks.data]);

  const chart = useMemo(() => {
    const start = list.reduce((min, t) => (t.start_date < min ? t.start_date : min), SCHEDULE_START);
    const latest = list.reduce((max, t) => (t.end_date > max ? t.end_date : max), today);
    const minEnd = addDays(start, 120);
    const padded = addDays(latest, 30);
    const end = padded > minEnd ? padded : minEnd;
    return { start, end, days: dayNumber(end) - dayNumber(start) + 1, months: monthSegments(start, end) };
  }, [list, today]);

  const groups = useMemo(() => {
    const map = new Map<string, ScheduleTask[]>();
    for (const t of list) map.set(t.category || UNCATEGORIZED, [...(map.get(t.category || UNCATEGORIZED) ?? []), t]);
    return [...map.entries()];
  }, [list]);

  const move = useAction((p: { id: string } & DateRange) => rpc('upsert_schedule_task', { p }));

  const todayOffset = dayNumber(today) - dayNumber(chart.start);
  const scrollToToday = () => scroller.current?.scrollTo({ left: Math.max(0, (todayOffset - 3) * dayWidth), behavior: 'smooth' });
  useEffect(() => {
    if (!tasks.data || scrolledToToday.current || !scroller.current) return;
    scrolledToToday.current = true;
    scroller.current.scrollLeft = Math.max(0, (todayOffset - 3) * dayWidth);
  }, [tasks.data, todayOffset, dayWidth]);

  // 切換顯示範圍時，畫面左邊停在同一天
  const changeZoom = (next: Zoom) => {
    const el = scroller.current;
    const leftDay = el ? el.scrollLeft / dayWidth : 0;
    setZoom(next);
    requestAnimationFrame(() => el && (el.scrollLeft = leftDay * DAY_WIDTH[next]));
  };

  if (tasks.isLoading) return <Loading />;
  if (tasks.error) return <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />;

  const states = list.map((t) => taskState(t, today));
  const count = (s: string) => states.filter((x) => x === s).length;

  const startDrag = (e: ReactPointerEvent<HTMLElement>, task: ScheduleTask, mode: DragMode) => {
    if (!adjusting) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const origin = { start_date: task.start_date, end_date: task.end_date };
    setDrag({ id: task.id, mode, startX: e.clientX, origin, range: origin });
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.startX) / dayWidth);
    setDrag({ ...drag, range: applyDrag(drag.origin, drag.mode, delta, chart.start) });
  };
  const endDrag = (task: ScheduleTask) => {
    if (!drag) return;
    const { range, origin } = drag;
    setDrag(null);
    if (range.start_date === origin.start_date && range.end_date === origin.end_date) {
      // 沒有移動：當成點一下
      setEditing(task);
      return;
    }
    // 先更新畫面，存檔完成後會重新讀取；失敗時錯誤提示會出現，畫面也會回到資料庫的內容
    client.setQueryData<ScheduleTask[]>(['list_schedule_tasks', {}], (old) =>
      old?.map((t) => (t.id === task.id ? { ...t, ...range } : t)),
    );
    move.mutate({ id: task.id, ...range }, { onSuccess: () => toast(`「${task.name}」改為 ${rangeText(range)}`) });
  };

  // 週一到週五空白、週六日淡灰；用背景位移對齊時間線起點是星期幾
  const weekBackground =
    zoom === 'week'
      ? {
          backgroundImage: `linear-gradient(to right, transparent ${5 * dayWidth}px, rgb(0 0 0 / 0.04) ${5 * dayWidth}px)`,
          backgroundSize: `${7 * dayWidth}px 100%`,
          backgroundPositionX: `${-((weekday(chart.start) + 6) % 7) * dayWidth}px`,
        }
      : undefined;
  const trackStyle = { width: chart.days * dayWidth, ...weekBackground };
  const labelBase = 'sticky left-0 z-10 w-32 shrink-0 border-r border-line px-2 md:w-48';
  const labelCell = `${labelBase} bg-white`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="開店時間表"
        subtitle="開店前置作業的安排：裝潢、設備、證照、人事…"
        actions={
          <Button small onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden />
            新增
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <ChipGroup<Zoom>
          label="顯示範圍"
          value={zoom}
          onChange={(z) => z && changeZoom(z)}
          options={[
            { value: 'week', label: '看幾週' },
            { value: 'month', label: '看幾個月' },
          ]}
        />
        <Button variant={adjusting ? 'primary' : 'secondary'} aria-pressed={adjusting} onClick={() => setAdjusting(!adjusting)}>
          <Move className="size-4" aria-hidden />
          {adjusting ? '拖拉調整中' : '拖拉調整'}
        </Button>
        <Button variant="ghost" onClick={scrollToToday}>
          回到今天
        </Button>
      </div>
      <p className="text-sm text-muted">
        {adjusting
          ? '拖色條可以整段移動，拖左右兩端可以改開始或結束日；放開就會儲存。要左右捲動請拖空白的地方。'
          : '點項目可以修改內容；要用拖的調整日期，先按「拖拉調整」。'}
      </p>

      {list.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone="info">進行中 {count('active')}</Badge>
          <Badge tone={count('overdue') > 0 ? 'danger' : 'neutral'}>逾期未完成 {count('overdue')}</Badge>
          <Badge>還沒開始 {count('upcoming')}</Badge>
          <Badge tone="ok">
            已完成 {count('done')}／{list.length}
          </Badge>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState title="還沒有任何項目">按右上角「新增」，輸入項目名稱和預計的開始、結束日期。</EmptyState>
      ) : (
        <div ref={scroller} className="overflow-x-auto rounded-2xl bg-white ring-1 ring-line" data-testid="schedule-chart">
          <div className="w-max select-none">
            {/* 月份 */}
            <div className="flex h-7 text-xs font-semibold text-muted">
              <div className={labelCell} />
              <div className="relative" style={{ width: chart.days * dayWidth }}>
                {chart.months.map((m) => (
                  <div
                    key={m.label}
                    className="absolute inset-y-0 border-l border-line leading-7"
                    style={{ left: m.offset * dayWidth, width: m.days * dayWidth }}
                  >
                    {/* 捲動時月份標題跟著停在左邊，隨時看得到現在是幾月 */}
                    <span className="sticky left-32 inline-block px-1 md:left-48">{m.label}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* 日期：看幾週時每天一格，看幾個月時只標每週一 */}
            <div className="flex h-6 border-t border-line text-[11px] text-muted">
              <div className={labelCell} />
              <div className="relative" style={trackStyle}>
                {Array.from({ length: chart.days }, (_, i) => i)
                  .filter((i) => zoom === 'week' || weekday(addDays(chart.start, i)) === 1)
                  .map((i) => {
                    const iso = addDays(chart.start, i);
                    return (
                      <div
                        key={i}
                        className={cx('absolute inset-y-0 leading-6', zoom === 'week' ? 'text-center' : 'border-l border-line pl-0.5', iso === today && 'font-bold text-red-600')}
                        style={{ left: i * dayWidth, width: zoom === 'week' ? dayWidth : 7 * dayWidth }}
                      >
                        {zoom === 'week' ? Number(iso.slice(8)) : shortDate(iso)}
                      </div>
                    );
                  })}
              </div>
            </div>

            {groups.map(([category, items], gi) => (
              <div key={category}>
                <div className="flex h-8 border-t border-line bg-stone-50 text-sm font-semibold">
                  <div className={cx(labelBase, 'truncate bg-stone-50 leading-8')}>
                    {category}（{items.length}）
                  </div>
                  <div style={{ width: chart.days * dayWidth }} />
                </div>
                {items.map((task) => {
                  const range = drag?.id === task.id ? drag.range : task;
                  const state = taskState(task, today);
                  const left = (dayNumber(range.start_date) - dayNumber(chart.start)) * dayWidth;
                  const width = durationDays(range) * dayWidth;
                  return (
                    <div key={task.id} className="flex h-11 border-t border-line">
                      <button
                        type="button"
                        onClick={() => setEditing(task)}
                        className={cx(labelCell, 'flex items-center gap-1 text-left text-xs leading-tight hover:bg-brand-50 md:text-sm')}
                        title={`${task.name}｜${rangeText(task)}`}
                      >
                        {task.is_done && <Check className="size-4 shrink-0 text-emerald-600" aria-label="已完成" />}
                        <span className={cx('line-clamp-2 md:line-clamp-1', task.is_done && 'text-muted line-through', state === 'overdue' && 'font-semibold text-red-700')}>
                          {task.name}
                        </span>
                      </button>
                      <div className="relative" style={trackStyle}>
                        {todayOffset >= 0 && (
                          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500/70" style={{ left: todayOffset * dayWidth + dayWidth / 2 }} aria-hidden />
                        )}
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={`${task.name} ${rangeText(range)}`}
                          onClick={() => !adjusting && setEditing(task)}
                          onKeyDown={(e) => e.key === 'Enter' && setEditing(task)}
                          onPointerDown={(e) => startDrag(e, task, 'move')}
                          onPointerMove={onDragMove}
                          onPointerUp={() => endDrag(task)}
                          onPointerCancel={() => setDrag(null)}
                          className={cx(
                            'absolute top-1.5 flex h-8 items-center overflow-hidden rounded-lg text-xs font-medium whitespace-nowrap text-white shadow-sm',
                            BAR_COLORS[gi % BAR_COLORS.length],
                            task.is_done && 'opacity-45',
                            state === 'overdue' && 'ring-2 ring-red-500 ring-offset-1',
                            adjusting ? 'cursor-grab touch-none active:cursor-grabbing' : 'cursor-pointer',
                            drag?.id === task.id && 'z-10 shadow-lg',
                          )}
                          style={{ left: left + 1, width: Math.max(width - 2, 6) }}
                        >
                          {adjusting && (
                            <span
                              aria-hidden
                              onPointerDown={(e) => startDrag(e, task, 'resize-start')}
                              onPointerMove={onDragMove}
                              onPointerUp={(e) => (e.stopPropagation(), endDrag(task))}
                              className="absolute inset-y-0 left-0 w-3 cursor-ew-resize touch-none rounded-l-lg bg-black/25"
                            />
                          )}
                          <span className="pointer-events-none px-3.5">
                            {drag?.id === task.id ? rangeText(range) : width > 70 ? `${durationDays(range)} 天` : ''}
                          </span>
                          {adjusting && (
                            <span
                              aria-hidden
                              onPointerDown={(e) => startDrag(e, task, 'resize-end')}
                              onPointerMove={onDragMove}
                              onPointerUp={(e) => (e.stopPropagation(), endDrag(task))}
                              className="absolute inset-y-0 right-0 w-3 cursor-ew-resize touch-none rounded-r-lg bg-black/25"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <TaskSheet
          task={editing === 'new' ? undefined : editing}
          categories={[...new Set([...list.map((t) => t.category).filter(Boolean), ...CATEGORY_HINTS])]}
          defaultStart={today > SCHEDULE_START ? today : SCHEDULE_START}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TaskSheet({
  task,
  categories,
  defaultStart,
  onClose,
}: {
  task?: ScheduleTask;
  categories: string[];
  defaultStart: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(task?.name ?? '');
  const [category, setCategory] = useState(task?.category ?? '');
  const [start, setStart] = useState(task?.start_date ?? defaultStart);
  const [end, setEnd] = useState(task?.end_date ?? addDays(defaultStart, 6));
  const [done, setDone] = useState(task?.is_done ?? false);
  const [note, setNote] = useState(task?.note ?? '');
  const save = useAction(() =>
    rpc('upsert_schedule_task', {
      p: { id: task?.id ?? '', name, category, start_date: start, end_date: end, is_done: done, note },
    }),
  );
  const remove = useAction(() => rpc('delete_schedule_task', { p_id: task!.id }));
  const valid = !!name.trim() && !!start && !!end && end >= start;

  return (
    <Sheet
      open
      onClose={onClose}
      title={task ? '修改項目' : '新增項目'}
      footer={
        <>
          {task && (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => confirm(`確定刪除「${task.name}」？`) && remove.mutate(undefined, { onSuccess: () => (toast('已刪除'), onClose()) })}
            >
              刪除
            </Button>
          )}
          <Button block loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined, { onSuccess: () => (toast('已儲存'), onClose()) })}>
            儲存
          </Button>
        </>
      }
    >
      <Field label="項目名稱">
        {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：水電配管、冷凍櫃進場" autoFocus={!task} />}
      </Field>
      <Field label="分類" hint="同一個分類會排在一起、用同一個顏色">
        {(id) => (
          <>
            <Input id={id} list="schedule-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="例如：裝潢、設備" />
            <datalist id="schedule-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="開始日期">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={start}
              onChange={(e) => {
                // 改開始日時整段一起移動，天數不變
                const next = e.target.value;
                if (next && start && end >= start) setEnd(addDays(next, dayNumber(end) - dayNumber(start)));
                setStart(next);
              }}
            />
          )}
        </Field>
        <Field label="結束日期" error={start && end && end < start ? '不能早於開始日期' : null}>
          {(id) => <Input id={id} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />}
        </Field>
      </div>
      {start && end && end >= start && (
        <p className="text-sm text-muted">
          {formatDate(start)} 到 {formatDate(end)}，共 {durationDays({ start_date: start, end_date: end })} 天（含頭尾）
        </p>
      )}
      <Checkbox checked={done} onChange={setDone} label="已完成" />
      <Field label="備註（選填）">{(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：廠商、聯絡人、要注意的事" />}</Field>
    </Sheet>
  );
}
