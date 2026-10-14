/**
 * Supabase 寄出的重設密碼信，連結點開後會把 token 放在網址 # 後面（例如 #access_token=…&type=recovery）。
 * 這個網站的路由也用 #（HashRouter），兩者會打架，所以要在路由啟動前先把 token 取出來、換成正常的頁面網址。
 */

export interface AuthRedirect {
  type: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** 連結過期或已經用過時，Supabase 帶回來的錯誤說明 */
  error: string | null;
}

/** 解析網址 # 後面的內容；不是 Supabase 帶回來的參數就回傳 null */
export function parseAuthHash(hash: string): AuthRedirect | null {
  const text = hash.replace(/^#\/?/, '');
  if (!/(^|&)(access_token|error_description|error_code)=/.test(text)) return null;
  const params = new URLSearchParams(text);
  return {
    type: params.get('type'),
    accessToken: params.get('access_token'),
    refreshToken: params.get('refresh_token'),
    error: params.get('error_description') ?? (params.get('error_code') ? '連結無效或已過期' : null),
  };
}

let pending: AuthRedirect | null = null;

/** 在建立路由之前呼叫一次 */
export function captureAuthRedirect(): void {
  const parsed = parseAuthHash(window.location.hash);
  if (!parsed) return;
  pending = parsed;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
}

/** 只能取一次（後端初始化時取走） */
export function takeAuthRedirect(): AuthRedirect | null {
  const value = pending;
  pending = null;
  return value;
}
