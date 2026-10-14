import { type FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../app/auth';
import { Button, Card, Field, Input, Notice, useToast } from '../components/ui';
import type { DemoUser } from '../data/backend';
import { ROLE_LABEL } from '../i18n/labels';

export function LoginPage() {
  const { backend } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [resetSent, setResetSent] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoUsers, setDemoUsers] = useState<DemoUser[]>([]);

  useEffect(() => {
    backend?.listDemoUsers?.().then(setDemoUsers).catch(() => setDemoUsers([]));
  }, [backend]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!backend) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await backend.signIn(email, password);
      } else if (mode === 'forgot') {
        if (!email.trim()) throw new Error('請填寫 Email');
        await backend.requestPasswordReset(email);
        setResetSent(true);
      } else {
        if (!name.trim()) throw new Error('請填寫姓名');
        if (password.length < 8) throw new Error('密碼至少 8 個字元');
        await backend.signUp(email, password, name.trim());
        toast('註冊完成；請等創辦人開通權限');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <div className="text-4xl" aria-hidden>
          🍜
        </div>
        <h1 className="mt-2 text-2xl font-bold text-brand-700">試菜與標準食譜系統</h1>
        <p className="mt-1 text-sm text-muted">麵店籌備團隊內部使用</p>
      </div>

      {backend?.mode === 'demo' && demoUsers.length > 0 && (
        <Card className="mb-4 space-y-3">
          <Notice tone="info" title="示範模式">
            資料只存在這台裝置的瀏覽器。選一個角色進入，看看各角色能做的事。
          </Notice>
          <div className="grid gap-2">
            {demoUsers.map((u) => (
              <Button key={u.id} variant="secondary" block onClick={() => backend.signInAs?.(u.id)}>
                <span className="flex w-full items-center justify-between">
                  <span>{u.display_name}</span>
                  <span className="text-sm text-muted">{ROLE_LABEL[u.role]}</span>
                </span>
              </Button>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <form onSubmit={submit} className="space-y-4">
          <h2 className="text-lg font-semibold">{mode === 'signin' ? '登入' : mode === 'signup' ? '註冊新帳號' : '忘記密碼'}</h2>
          {mode === 'forgot' && (
            <p className="text-sm text-muted">輸入註冊時用的 Email，系統會寄一封重設密碼的信；點信裡的連結就能設定新密碼。</p>
          )}
          {mode === 'signup' && (
            <Field label="姓名">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>
          )}
          <Field label="Email">
            {(id) => (
              <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            )}
          </Field>
          {mode !== 'forgot' && (
          <Field label="密碼" hint={mode === 'signup' ? '至少 8 個字元' : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required={backend?.mode !== 'demo'}
              />
            )}
          </Field>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {mode === 'forgot' && resetSent && (
            <Notice tone="ok" title="已送出">
              如果這個 Email 有註冊，幾分鐘內會收到重設密碼的信（也看一下垃圾郵件匣）。連結只能用一次，而且有時效。
            </Notice>
          )}
          <Button type="submit" block loading={busy}>
            {mode === 'signin' ? '登入' : mode === 'signup' ? '註冊' : resetSent ? '再寄一次' : '寄出重設密碼信'}
          </Button>
          {mode === 'signin' && (
            <button
              type="button"
              className="min-h-11 w-full text-sm text-muted"
              onClick={() => {
                setMode('forgot');
                setError(null);
                setResetSent(false);
              }}
            >
              忘記密碼？
            </button>
          )}
          <button
            type="button"
            className="min-h-11 w-full text-sm text-brand-700"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError(null);
            }}
          >
            {mode === 'signin' ? '還沒有帳號？註冊' : '回到登入'}
          </button>
        </form>
      </Card>
      <p className="mt-4 text-center text-xs text-muted">新註冊的帳號需要創辦人指派角色後才能使用。</p>
    </div>
  );
}

/** 從重設密碼信的連結打開：設定新密碼 */
export function ResetPasswordPage() {
  const { backend, recovery, finishRecovery } = useAuth();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!backend) return;
    setError(null);
    if (password.length < 8) return setError('密碼至少 8 個字元');
    if (password !== confirmPassword) return setError('兩次輸入的密碼不一樣');
    setBusy(true);
    try {
      await backend.updatePassword(password);
      toast('已設定新密碼');
      finishRecovery();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <Card>
        {recovery?.error ? (
          <div className="space-y-4">
            <h1 className="text-lg font-semibold">重設密碼的連結不能用</h1>
            <Notice tone="danger">{recovery.error}</Notice>
            <p className="text-sm text-muted">連結只能用一次，而且有時效。請回到登入頁按「忘記密碼？」重新申請。</p>
            <Button block onClick={finishRecovery}>
              回到登入頁
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h1 className="text-lg font-semibold">設定新密碼</h1>
            <Field label="新密碼" hint="至少 8 個字元">
              {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />}
            </Field>
            <Field label="再輸入一次">
              {(id) => (
                <Input id={id} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
              )}
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button type="submit" block loading={busy}>
              儲存新密碼
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

export function PendingPage() {
  const { me, backend } = useAuth();
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 text-center">
      <div className="text-4xl" aria-hidden>
        ⏳
      </div>
      <h1 className="mt-3 text-xl font-bold">等待開通</h1>
      <p className="mt-2 text-muted">
        {me?.display_name}，你的帳號{me?.is_active === false ? '已被停用' : '還沒有被指派角色'}。請聯絡創辦人開通權限。
      </p>
      <Button variant="secondary" className="mx-auto mt-6" onClick={() => backend?.signOut()}>
        登出
      </Button>
    </div>
  );
}
