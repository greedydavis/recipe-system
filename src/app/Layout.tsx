import { BookOpen, ClipboardCheck, Home, Menu, Package } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { cx } from '../components/ui';
import type { Role } from '../domain/types';
import { ROLE_LABEL } from '../i18n/labels';
import { useAuth } from './auth';

const NAV: Array<{ to: string; label: string; icon: typeof Home; roles: Role[]; end?: boolean }> = [
  { to: '/', label: '首頁', icon: Home, roles: ['founder', 'chef', 'manager', 'tester'], end: true },
  { to: '/recipes', label: '食譜', icon: BookOpen, roles: ['founder', 'chef', 'manager'] },
  { to: '/tastings', label: '試菜', icon: ClipboardCheck, roles: ['founder', 'chef', 'manager', 'tester'] },
  { to: '/ingredients', label: '原物料', icon: Package, roles: ['founder', 'chef', 'manager'] },
  { to: '/more', label: '更多', icon: Menu, roles: ['founder', 'chef', 'manager', 'tester'] },
];

export function Layout() {
  const { me, backend } = useAuth();
  const items = NAV.filter((n) => me && n.roles.includes(me.role));

  return (
    <div className="min-h-dvh md:pl-60">
      {backend?.mode === 'demo' && (
        <div className="no-print bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          示範模式：資料只存在這台裝置的瀏覽器
          {me && `（目前身分：${me.display_name}／${ROLE_LABEL[me.role]}）`}
        </div>
      )}

      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-white md:flex">
        <div className="px-5 py-5">
          <div className="text-lg font-bold text-brand-700">試菜與標準食譜</div>
          {me && (
            <div className="mt-1 text-sm text-muted">
              {me.display_name}・{ROLE_LABEL[me.role]}
            </div>
          )}
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {items.map((n) => (
            <SideLink key={n.to} to={n.to} end={n.end} icon={<n.icon className="size-5" aria-hidden />}>
              {n.label}
            </SideLink>
          ))}
        </nav>
      </aside>

      <main className="mx-auto max-w-3xl px-4 pt-4 pb-24 md:pb-10">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>

      <nav
        className="no-print safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white md:hidden"
        aria-label="主選單"
      >
        <div className="flex">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx(
                  'flex h-16 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium',
                  isActive ? 'text-brand-700' : 'text-muted',
                )
              }
            >
              <n.icon className="size-6" aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

function SideLink({ to, end, icon, children }: { to: string; end?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'flex min-h-11 items-center gap-3 rounded-xl px-3 font-medium',
          isActive ? 'bg-brand-50 text-brand-700' : 'text-ink hover:bg-stone-50',
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="space-y-3 py-10 text-center">
        <div className="text-lg font-semibold">畫面發生錯誤</div>
        <p className="text-sm text-muted">{this.state.error.message}</p>
        <button type="button" className="min-h-11 rounded-xl px-4 text-brand-700 ring-1 ring-line" onClick={() => location.reload()}>
          重新整理
        </button>
      </div>
    );
  }
}

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { me } = useAuth();
  if (!me || !roles.includes(me.role)) {
    return (
      <div className="py-12 text-center">
        <div className="text-lg font-semibold">權限不足</div>
        <p className="mt-1 text-muted">你的角色無法使用這個頁面。</p>
      </div>
    );
  }
  return <>{children}</>;
}
