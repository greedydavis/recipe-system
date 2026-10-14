import { describe, expect, it } from 'vitest';
import { parseAuthHash } from './authRedirect';

describe('重設密碼信的網址', () => {
  it('取出 token 與類型', () => {
    expect(parseAuthHash('#access_token=a.b.c&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery')).toEqual({
      type: 'recovery',
      accessToken: 'a.b.c',
      refreshToken: 'r1',
      error: null,
    });
  });

  it('連結過期時帶回錯誤說明', () => {
    expect(parseAuthHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).toMatchObject({
      accessToken: null,
      error: 'Email link is invalid or has expired',
    });
    expect(parseAuthHash('#error=access_denied&error_code=otp_expired')?.error).toBe('連結無效或已過期');
  });

  it('一般的頁面網址不受影響', () => {
    expect(parseAuthHash('#/recipes')).toBeNull();
    expect(parseAuthHash('#/ingredients?missing=1')).toBeNull();
    expect(parseAuthHash('')).toBeNull();
  });
});
