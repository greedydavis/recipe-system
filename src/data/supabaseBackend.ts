import { createClient } from '@supabase/supabase-js';
import { type Backend, RpcError } from './backend';

const BUCKET = 'photos';
const SIGNED_URL_SECONDS = 3600;

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const client = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  // 同一張照片在清單、放大、切換分頁時會重複顯示；簽名網址在到期前重複使用，不必每次都向 Storage 要一次
  const signedUrls = new Map<string, { url: Promise<string>; expiresAt: number }>();
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') signedUrls.clear();
  });

  return {
    mode: 'supabase',

    async getSession() {
      const { data } = await client.auth.getSession();
      const user = data.session?.user;
      return user ? { id: user.id, email: user.email ?? null } : null;
    },

    onAuthChange(callback) {
      const { data } = client.auth.onAuthStateChange((_event, session) => callback(session?.user.id ?? null));
      return () => data.subscription.unsubscribe();
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new RpcError(error.message === 'Invalid login credentials' ? 'Email 或密碼錯誤' : error.message);
    },

    async signUp(email, password, displayName) {
      const { error } = await client.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
      if (error) throw new RpcError(error.message);
    },

    async signOut() {
      await client.auth.signOut();
    },

    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new RpcError(error.message, error.code);
      return data as T;
    },

    async uploadPhoto(path, file) {
      const { error } = await client.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new RpcError(`照片上傳失敗：${error.message}`);
    },

    photoUrl(path) {
      const cached = signedUrls.get(path);
      if (cached && cached.expiresAt > Date.now()) return cached.url;
      const url = client.storage
        .from(BUCKET)
        .createSignedUrl(path, SIGNED_URL_SECONDS)
        .then(({ data, error }) => {
          if (error || !data) throw new RpcError('無法讀取照片');
          return data.signedUrl;
        });
      // 提早 5 分鐘視為過期；失敗的不留在快取裡，下次會重試
      signedUrls.set(path, { url, expiresAt: Date.now() + (SIGNED_URL_SECONDS - 300) * 1000 });
      url.catch(() => signedUrls.delete(path));
      return url;
    },

    async removePhotoFile(path) {
      const { error } = await client.storage.from(BUCKET).remove([path]);
      if (error) throw new RpcError(`照片檔案刪除失敗：${error.message}`);
      signedUrls.delete(path);
    },
  };
}
