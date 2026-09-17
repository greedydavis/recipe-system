import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type Backend, type SessionUser, getBackend } from '../data/backend';
import type { Me } from '../data/types';
import type { Role } from '../domain/types';

interface AuthState {
  backend: Backend | null;
  session: SessionUser | null;
  me: Me | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [backend, setBackend] = useState<Backend | null>(null);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (b: Backend) => {
    const s = await b.getSession();
    setSession(s);
    setMe(s ? await b.rpc<Me | null>('me') : null);
  }, []);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getBackend()
      .then(async (b) => {
        if (cancelled) return;
        setBackend(b);
        await load(b);
        unsubscribe = b.onAuthChange(() => {
          client.clear();
          load(b).catch((e: Error) => setError(e.message));
        });
      })
      .catch((e: Error) => setError(`無法連線資料庫：${e.message}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, load]);

  const refresh = useCallback(async () => {
    if (backend) await load(backend);
  }, [backend, load]);

  return (
    <AuthContext.Provider value={{ backend, session, me, loading, error, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必須在 AuthProvider 內使用');
  return ctx;
}

export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('尚未登入');
  return me;
}

export function useRole(): Role {
  return useMe().role;
}

export const can = {
  editRecipes: (r: Role) => r === 'founder' || r === 'chef',
  viewKitchen: (r: Role) => r === 'founder' || r === 'chef' || r === 'manager',
  editMaster: (r: Role) => r === 'founder' || r === 'chef' || r === 'manager',
  approve: (r: Role) => r === 'founder',
  setPrice: (r: Role) => r === 'founder',
  admin: (r: Role) => r === 'founder',
  viewAudit: (r: Role) => r === 'founder' || r === 'chef',
  runTasting: (r: Role) => r === 'founder' || r === 'chef' || r === 'manager',
};
