const TZ = 'Asia/Taipei';

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // 純日期（YYYY-MM-DD）不做時區換算
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '/');
  return new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(value),
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function todayIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
  return parts;
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(1).replace(/\.0$/, '');
}

export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  const s = n.toFixed(1).replace(/\.0$/, '');
  return n > 0 ? `+${s}` : s;
}

/** 表單數字欄位：字串 → 數字或 null */
export function toNum(value: string): number | null {
  const t = value.trim();
  if (t === '' || t === '.' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function numStr(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}
