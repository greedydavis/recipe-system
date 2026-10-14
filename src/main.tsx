import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, RouterProvider, createHashRouter } from 'react-router';
import { AuthProvider, useAuth } from './app/auth';
import { captureAuthRedirect } from './app/authRedirect';
import { Layout, RequireRole } from './app/Layout';
import { Loading, Notice, ToastProvider } from './components/ui';
import type { Role } from './domain/types';
import './index.css';
import { AuditPage, DataPage, MorePage, SettingsPage, UsersPage } from './pages/AdminPages';
import { CardPage } from './pages/CardPage';
import { ComparePage } from './pages/ComparePage';
import { HomePage } from './pages/HomePage';
import { ProgressPage } from './pages/ProgressPage';
import { IngredientDetailPage, IngredientsPage, SupplierDetailPage, SuppliersPage } from './pages/IngredientPages';
import { LoginPage, PendingPage, ResetPasswordPage } from './pages/LoginPage';
import { RecipeDetailPage } from './pages/RecipeDetailPage';
import { RecipesPage } from './pages/RecipesPage';
import { SchedulePage } from './pages/SchedulePage';
import { FeedbackPage, TastingNewPage, TastingSessionPage, TastingsPage } from './pages/TastingPages';
import { VersionEditPage } from './pages/VersionEditPage';
import { VersionPage } from './pages/VersionPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

function Gate() {
  const { loading, error, session, me, recovery } = useAuth();
  if (loading) {
    return (
      <Loading
        label={
          import.meta.env.VITE_SUPABASE_URL
            ? '連線資料庫中…'
            : '載入示範資料庫中…第一次開啟約需 10–20 秒，請不要重新整理或關閉分頁'
        }
      />
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-md p-4">
        <Notice tone="danger" title="無法啟動">
          {error}
        </Notice>
      </div>
    );
  }
  if (recovery) return <ResetPasswordPage />;
  if (!session) return <LoginPage />;
  if (!me || me.role === 'pending' || !me.is_active) return <PendingPage />;
  return <Outlet />;
}

const KITCHEN: Role[] = ['founder', 'chef', 'manager'];

/** 哪個角色能進哪一頁集中寫在這裡；這只是畫面上的體驗，真正的權限由資料庫 RPC 檢查 */
function guard(roles: Role[], element: ReactNode) {
  return <RequireRole roles={roles}>{element}</RequireRole>;
}

// 一定要在建立路由之前：重設密碼信的 token 放在網址 # 後面，路由會把它當成頁面路徑
captureAuthRedirect();

const router = createHashRouter([
  {
    element: <Gate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'progress', element: guard(KITCHEN, <ProgressPage />) },
          { path: 'schedule', element: guard(KITCHEN, <SchedulePage />) },
          { path: 'recipes', element: guard(KITCHEN, <RecipesPage />) },
          { path: 'recipes/:id', element: guard(KITCHEN, <RecipeDetailPage />) },
          { path: 'versions/:id', element: guard(KITCHEN, <VersionPage />) },
          { path: 'versions/:id/edit', element: guard(['founder', 'chef'], <VersionEditPage />) },
          { path: 'versions/:id/card', element: guard(KITCHEN, <CardPage />) },
          { path: 'compare', element: guard(KITCHEN, <ComparePage />) },
          { path: 'tastings', element: <TastingsPage /> },
          { path: 'tastings/new', element: guard(KITCHEN, <TastingNewPage />) },
          { path: 'tastings/:id', element: guard(KITCHEN, <TastingSessionPage />) },
          { path: 'tasting-items/:id/feedback', element: <FeedbackPage /> },
          { path: 'ingredients', element: guard(KITCHEN, <IngredientsPage />) },
          { path: 'ingredients/:id', element: guard(KITCHEN, <IngredientDetailPage />) },
          { path: 'suppliers', element: guard(KITCHEN, <SuppliersPage />) },
          { path: 'suppliers/:id', element: guard(KITCHEN, <SupplierDetailPage />) },
          { path: 'more', element: <MorePage /> },
          { path: 'admin/users', element: guard(['founder'], <UsersPage />) },
          { path: 'admin/settings', element: guard(KITCHEN, <SettingsPage />) },
          { path: 'admin/data', element: guard(['founder'], <DataPage />) },
          { path: 'audit', element: guard(['founder', 'chef'], <AuditPage />) },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
