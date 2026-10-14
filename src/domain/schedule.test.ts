import { describe, expect, it } from 'vitest';
import { addDays, applyDrag, dayNumber, durationDays, isoFromDay, monthSegments, taskState, weekday } from './schedule';

const range = { start_date: '2026-09-10', end_date: '2026-09-14' };
const MIN = '2026-09-01';

describe('日期換算', () => {
  it('日期和天數互轉，跨月、跨年、閏年都正確', () => {
    expect(isoFromDay(dayNumber('2026-09-01'))).toBe('2026-09-01');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('天數包含結束日當天', () => {
    expect(durationDays(range)).toBe(5);
    expect(durationDays({ start_date: '2026-09-10', end_date: '2026-09-10' })).toBe(1);
  });

  it('星期幾', () => {
    expect(weekday('2026-09-01')).toBe(2);
    expect(weekday('2026-09-06')).toBe(0);
  });
});

describe('拖拉', () => {
  it('整條移動：天數不變', () => {
    expect(applyDrag(range, 'move', 3, MIN)).toEqual({ start_date: '2026-09-13', end_date: '2026-09-17' });
    expect(applyDrag(range, 'move', -2, MIN)).toEqual({ start_date: '2026-09-08', end_date: '2026-09-12' });
  });

  it('整條移動：不會早於時間線起點，天數仍然不變', () => {
    expect(applyDrag(range, 'move', -30, MIN)).toEqual({ start_date: '2026-09-01', end_date: '2026-09-05' });
  });

  it('拉開始那一端：不早於起點，也不會超過結束日', () => {
    expect(applyDrag(range, 'resize-start', -3, MIN)).toEqual({ start_date: '2026-09-07', end_date: '2026-09-14' });
    expect(applyDrag(range, 'resize-start', -30, MIN)).toEqual({ start_date: '2026-09-01', end_date: '2026-09-14' });
    expect(applyDrag(range, 'resize-start', 30, MIN)).toEqual({ start_date: '2026-09-14', end_date: '2026-09-14' });
  });

  it('拉結束那一端：至少保留 1 天', () => {
    expect(applyDrag(range, 'resize-end', 6, MIN)).toEqual({ start_date: '2026-09-10', end_date: '2026-09-20' });
    expect(applyDrag(range, 'resize-end', -30, MIN)).toEqual({ start_date: '2026-09-10', end_date: '2026-09-10' });
  });
});

describe('月份標題', () => {
  it('一個月一段，頭尾不滿一個月也算', () => {
    expect(monthSegments('2026-09-15', '2026-11-10')).toEqual([
      { label: '2026/09', offset: 0, days: 16 },
      { label: '2026/10', offset: 16, days: 31 },
      { label: '2026/11', offset: 47, days: 10 },
    ]);
  });

  it('跨年', () => {
    expect(monthSegments('2026-12-31', '2027-01-01')).toEqual([
      { label: '2026/12', offset: 0, days: 1 },
      { label: '2027/01', offset: 1, days: 1 },
    ]);
  });
});

describe('項目狀態', () => {
  const task = { ...range, is_done: false };
  it('依今天的日期判斷', () => {
    expect(taskState(task, '2026-09-09')).toBe('upcoming');
    expect(taskState(task, '2026-09-10')).toBe('active');
    expect(taskState(task, '2026-09-14')).toBe('active');
    expect(taskState(task, '2026-09-15')).toBe('overdue');
  });
  it('已完成的不算逾期', () => {
    expect(taskState({ ...task, is_done: true }, '2026-12-01')).toBe('done');
  });
});
