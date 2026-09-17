import { ChevronLeft, Loader2, Search, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import { Link, type LinkProps, useNavigate } from 'react-router';
import type { VersionStatus } from '../domain/types';
import { STATUS_LABEL, STATUS_STYLE } from '../i18n/labels';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// ───────────── 按鈕 ─────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-800 disabled:bg-brand-700/50',
  secondary: 'bg-white text-ink ring-1 ring-line hover:bg-brand-50 disabled:text-muted',
  ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-muted',
  danger: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50 disabled:text-red-300',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  block?: boolean;
  small?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading, block, small, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors disabled:cursor-not-allowed',
        small ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4',
        block && 'w-full',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function LinkButton({
  variant = 'secondary',
  small,
  block,
  className,
  ...rest
}: LinkProps & { variant?: Variant; small?: boolean; block?: boolean }) {
  return (
    <Link
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors',
        small ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4',
        block && 'w-full',
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}

// ───────────── 版面 ─────────────

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-2xl bg-white p-4 ring-1 ring-line', className)}>{children}</div>;
}

export function Section({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('space-y-2', className)}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: string | true;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="no-print mb-4 flex items-start gap-2">
      {back && (
        <button
          type="button"
          aria-label="返回"
          onClick={() => (back === true ? navigate(-1) : navigate(back))}
          className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-xl text-brand-700 hover:bg-brand-50"
        >
          <ChevronLeft className="size-6" />
        </button>
      )}
      <div className="min-w-0 flex-1 pt-1.5">
        <h1 className="text-xl leading-tight font-bold break-words text-ink">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>}
    </header>
  );
}

/** 手機底部固定的主要操作列 */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="h-20" aria-hidden />
      <div className="no-print safe-bottom fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 backdrop-blur md:bottom-0 md:left-60">
        <div className="mx-auto flex max-w-3xl flex-wrap gap-2 px-4 py-3">{children}</div>
      </div>
    </>
  );
}

// ───────────── 狀態 ─────────────

export function StatusBadge({ status, className }: { status: VersionStatus; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLE[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

type Tone = 'neutral' | 'warn' | 'danger' | 'ok' | 'info';
const TONE: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  warn: 'bg-amber-100 text-amber-900',
  danger: 'bg-red-100 text-red-800',
  ok: 'bg-emerald-100 text-emerald-800',
  info: 'bg-sky-100 text-sky-800',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium', TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Notice({ tone = 'warn', title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  const style: Record<Tone, string> = {
    neutral: 'bg-stone-50 ring-stone-200 text-stone-800',
    warn: 'bg-amber-50 ring-amber-200 text-amber-900',
    danger: 'bg-red-50 ring-red-200 text-red-900',
    ok: 'bg-emerald-50 ring-emerald-200 text-emerald-900',
    info: 'bg-sky-50 ring-sky-200 text-sky-900',
  };
  return (
    <div className={cx('rounded-xl px-3 py-2.5 text-sm ring-1', style[tone])} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? 'mt-1' : undefined}>{children}</div>}
    </div>
  );
}

export function Loading({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  return (
    <Notice tone="danger" title="發生錯誤">
      <p>{error?.message ?? '無法載入資料'}</p>
      {onRetry && (
        <Button small variant="secondary" className="mt-2" onClick={onRetry}>
          重新載入
        </Button>
      )}
    </Notice>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center">
      <div className="font-medium text-ink">{title}</div>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

// ───────────── 表單 ─────────────

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

const inputBase =
  'block min-h-11 rounded-xl border-0 bg-white px-3 text-base text-ink ring-1 ring-line placeholder:text-stone-400 focus:ring-2 focus:ring-brand-600 focus:outline-none disabled:bg-stone-50 disabled:text-muted';

/** 沒有指定寬度（w-*、flex-1）時預設填滿 */
function inputClass(className?: string, extra?: string): string {
  const sized = /(^|\s)(w-|flex-1|min-w-)/.test(className ?? '');
  return cx(inputBase, !sized && 'w-full', sized && 'min-w-0', extra, className);
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={inputClass(className)} {...rest} />;
});

/** 數字輸入：保留使用者輸入的字串，只允許數字與小數點 */
export function NumberInput({
  value,
  onChange,
  allowNegative,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
  allowNegative?: boolean;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(e) => {
        const v = e.target.value.replace(/，/g, '.').replace(/[^\d.-]/g, '');
        const pattern = allowNegative ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/;
        if (pattern.test(v)) onChange(v);
      }}
      className={inputClass(className, 'tabular-nums')}
      {...rest}
    />
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={inputClass(className, 'shrink-0 pr-8')} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 3, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={inputClass(className, 'py-2.5')} {...rest} />;
});

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
      <input
        type="checkbox"
        className="size-5 rounded accent-brand-700"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜尋',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-stone-400" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass(undefined, 'pl-10')}
        aria-label={placeholder}
      />
    </div>
  );
}

/** 選項按鈕（評分、切換） */
export function ChipGroup<T extends string | number>({
  options,
  value,
  onChange,
  label,
  allowClear,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T | null;
  onChange: (v: T | null) => void;
  label: string;
  allowClear?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(active && allowClear ? null : o.value)}
            className={cx(
              'min-h-11 min-w-11 rounded-xl px-3 text-base font-medium ring-1 transition-colors',
              active ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-ink ring-line hover:bg-brand-50',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ key: T; label: ReactNode }>;
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div role="tablist" className="no-print -mx-4 mb-3 flex gap-1 overflow-x-auto border-b border-line px-4">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            'min-h-11 shrink-0 border-b-2 px-3 text-base font-medium whitespace-nowrap',
            value === t.key ? 'border-brand-700 text-brand-700' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ───────────── 彈出視窗 ─────────────

export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true">
      <button type="button" aria-label="關閉" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="safe-bottom relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl md:max-w-lg md:rounded-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" aria-label="關閉" onClick={onClose} className="flex size-11 items-center justify-center rounded-xl hover:bg-stone-100">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ───────────── 提示訊息 ─────────────

interface ToastItem {
  id: number;
  message: string;
  tone: 'ok' | 'danger';
}

const ToastContext = createContext<(message: string, tone?: 'ok' | 'danger') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((message: string, tone: 'ok' | 'danger' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, message, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'danger' ? 6000 : 2500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="no-print pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg',
              t.tone === 'ok' ? 'bg-ink text-white' : 'bg-red-700 text-white',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
