import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, RouterProvider, createHashRouter } from 'react-router';
import { AuthProvider, useAuth } from './app/auth';
import { Layout } from './app/Layout';
import { Loading, Notice, ToastProvider } from './components/ui';
import './index.css';
import { AuditPage, DataPage, MorePage, SettingsPage, UsersPage } from './pages/AdminPages';
import { CardPage } from './pages/CardPage';
import { ComparePage } from './pages/ComparePage';
import { HomePage } from './pages/HomePage';
import { ProgressPage } from './pages/ProgressPage';
import { IngredientDetailPage, IngredientsPage, SupplierDetailPage, SuppliersPage } from './pages/IngredientPages';
import { LoginPage, PendingPage } from './pages/LoginPage';
import { RecipeDetailPage } from './pages/RecipeDetailPage';
import { RecipesPage } from './pages/RecipesPage';
import { FeedbackPage, TastingNewPage, TastingSessionPage, TastingsPage } from './pages/TastingPages';
import { VersionEditPage } from './pages/VersionEditPage';
import { VersionPage } from './pages/VersionPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

function Gate() {
  const { loading, error, session, me } = useAuth();
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
  if (!session) return <LoginPage />;
  if (!me || me.role === 'pending' || !me.is_active) return <PendingPage />;
  return <Outlet />;
}

const router = createHashRouter([
  {
    element: <Gate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'progress', element: <ProgressPage /> },
          { path: 'recipes', element: <RecipesPage /> },
          { path: 'recipes/:id', element: <RecipeDetailPage /> },
          { path: 'versions/:id', element: <VersionPage /> },
          { path: 'versions/:id/edit', element: <VersionEditPage /> },
          { path: 'versions/:id/card', element: <CardPage /> },
          { path: 'compare', element: <ComparePage /> },
          { path: 'tastings', element: <TastingsPage /> },
          { path: 'tastings/new', element: <TastingNewPage /> },
          { path: 'tastings/:id', element: <TastingSessionPage /> },
          { path: 'tasting-items/:id/feedback', element: <FeedbackPage /> },
          { path: 'ingredients', element: <IngredientsPage /> },
          { path: 'ingredients/:id', element: <IngredientDetailPage /> },
          { path: 'suppliers', element: <SuppliersPage /> },
          { path: 'suppliers/:id', element: <SupplierDetailPage /> },
          { path: 'more', element: <MorePage /> },
          { path: 'admin/users', element: <UsersPage /> },
          { path: 'admin/settings', element: <SettingsPage /> },
          { path: 'admin/data', element: <DataPage /> },
          { path: 'audit', element: <AuditPage /> },
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
