import { createClient } from '@supabase/supabase-js';
import { takeAuthRedirect } from '../app/authRedirect';
import { type Backend, RpcError } from './backend';

const BUCKET = 'photos';
const SIGNED_URL_SECONDS = 3600;

/** Supabase 的英文錯誤訊息翻成中文；認不得的原樣顯示 */
function authMessage(message: string): string {
  if (/should be different from the old password/i.test(message)) return '新密碼不能和舊密碼相同';
  if (/at least \d+ characters/i.test(message)) return '密碼太短，至少 8 個字元';
  if (/rate limit|only request this after/i.test(message)) return '申請太頻繁，請過幾分鐘再試';
  if (/invalid email|unable to validate email/i.test(message)) return 'Email 格式不正確';
  return message;
}

export async function createSupabaseBackend(url: string, anonKey: string): Promise<Backend> {
  // 網址裡的 token 由 src/app/authRedirect.ts 先取出來自己處理（和 HashRouter 衝突）
  const client = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

  let recovery: Backend['recovery'] = null;
  const redirect = takeAuthRedirect();
  if (redirect?.error) {
    recovery = { error: redirect.error };
  } else if (redirect?.accessToken && redirect.refreshToken) {
    const { error } = await client.auth.setSession({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken });
    if (error) recovery = { error: '連結無效或已過期，請重新申請' };
    else if (redirect.type === 'recovery') recovery = { error: null };
  }
  // 同一張照片在清單、放大、切換分頁時會重複顯示；簽名網址在到期前重複使用，不必每次都向 Storage 要一次
  const signedUrls = new Map<string, { url: Promise<string>; expiresAt: number }>();
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') signedUrls.clear();
  });

  return {
    mode: 'supabase',
    recovery,

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

    async requestPasswordReset(email) {
      // 信裡的連結回到網站首頁；Supabase 的 Redirect URLs 要允許這個網址
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo });
      if (error) throw new RpcError(authMessage(error.message));
    },

    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw new RpcError(authMessage(error.message));
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
