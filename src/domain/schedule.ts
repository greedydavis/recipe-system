/** 時間表（甘特圖）的日期計算。日期一律用 YYYY-MM-DD 字串，換算成「第幾天」的整數來算，不受時區影響。 */

export interface DateRange {
  start_date: string;
  end_date: string;
}

export type DragMode = 'move' | 'resize-start' | 'resize-end';

const DAY_MS = 86_400_000;

/** YYYY-MM-DD → 從 1970-01-01 起算的天數 */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function isoFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoFromDay(dayNumber(iso) + days);
}

/** 工作天數；結束日含當天 */
export function durationDays(range: DateRange): number {
  return dayNumber(range.end_date) - dayNumber(range.start_date) + 1;
}

/**
 * 拖拉後的新日期。整條移動時天數不變；拉左右兩端時至少保留 1 天。
 * 開始日不會早於 minDate（時間線的起點）。
 */
export function applyDrag(range: DateRange, mode: DragMode, deltaDays: number, minDate: string): DateRange {
  const min = dayNumber(minDate);
  let start = dayNumber(range.start_date);
  let end = dayNumber(range.end_date);
  if (mode === 'move') {
    const shift = Math.max(deltaDays, min - start);
    start += shift;
    end += shift;
  } else if (mode === 'resize-start') {
    start = Math.min(Math.max(start + deltaDays, min), end);
  } else {
    end = Math.max(end + deltaDays, start);
  }
  return { start_date: isoFromDay(start), end_date: isoFromDay(end) };
}

export interface MonthSegment {
  /** 例如「2026/09」 */
  label: string;
  /** 這個月在時間線上的第一天（相對於時間線起點的第幾天，從 0 開始） */
  offset: number;
  days: number;
}

/** 把時間線切成一個月一段，畫月份標題用 */
export function monthSegments(startDate: string, endDate: string): MonthSegment[] {
  const first = dayNumber(startDate);
  const last = dayNumber(endDate);
  const segments: MonthSegment[] = [];
  let cursor = first;
  while (cursor <= last) {
    const date = new Date(cursor * DAY_MS);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS;
    const until = Math.min(nextMonth - 1, last);
    segments.push({
      label: `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
      offset: cursor - first,
      days: until - cursor + 1,
    });
    cursor = until + 1;
  }
  return segments;
}

/** 星期幾：0 是星期日 */
export function weekday(iso: string): number {
  return new Date(dayNumber(iso) * DAY_MS).getUTCDay();
}

export type TaskState = 'done' | 'overdue' | 'active' | 'upcoming';

/** 已完成／逾期（過了結束日還沒完成）／進行中／還沒開始 */
export function taskState(task: DateRange & { is_done: boolean }, today: string): TaskState {
  if (task.is_done) return 'done';
  if (task.end_date < today) return 'overdue';
  return task.start_date <= today ? 'active' : 'upcoming';
}
