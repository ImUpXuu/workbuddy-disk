/**
 * 登录 / 凭证配置页。
 *
 * 两条路径：
 *   1. 填 API Key  —— 前端主通道，key 存 localStorage，之后所有请求带 X-API-Key
 *   2. 填登录密钥  —— 换取 token，作为备选
 *
 * 因为后端与前端不同源，凭证不可能靠 Cookie 传递，所以这里
 * 拿到凭证后一律落到 localStorage。
 */

import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api, API_BASE, ApiError } from '../api/client'
import { Button, Icon, ICONS, Input } from '../components/ui'

type Tab = 'apikey' | 'login'

export default function LoginPage() {
  const { useApiKey, loginWithKey, error: authError } = useAuth()
  const toast = useToast()

  const [tab, setTab] = useState<Tab>('apikey')
  const [keyInput, setKeyInput] = useState('')
  const [loginInput, setLoginInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [localError, setLocalError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError('')

    const value = (tab === 'apikey' ? keyInput : loginInput).trim()
    if (!value) {
      setLocalError(tab === 'apikey' ? '请输入 API Key' : '请输入登录密钥')
      return
    }

    setBusy(true)
    try {
      if (tab === 'apikey') {
        // API Key 是自证的：先存下来，再发一个请求问后端认不认
        useApiKey(value)
        const res = await api.whoami()
        if (!res.authenticated) {
          throw new ApiError('unauthorized', 'API Key 无效或已被停用')
        }
        toast.success('已连接', 'API Key 已保存到本机')
      } else {
        await loginWithKey(value)
        toast.success('登录成功')
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.friendly : (err as Error).message
      setLocalError(msg)
      if (tab === 'apikey') useApiKey('') // 验证失败就别留着
    } finally {
      setBusy(false)
    }
  }

  const shownError = localError || authError

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* 品牌 */}
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-white/80 shadow-[var(--shadow-card)] backdrop-blur">
            <Icon d={ICONS.cloud} className="size-7 text-[--color-brand-500]" strokeWidth={1.8} />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight text-[--color-ink]">
            WorkBuddy Disk
          </h1>
          <p className="text-xs text-[--color-ink-soft]">轻量自托管网盘</p>
        </div>

        <div className="card p-5">
          {/* 通道切换 */}
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-full bg-slate-100/80 p-1">
            {([
              ['apikey', 'API Key'],
              ['login', '登录密钥'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id)
                  setLocalError('')
                }}
                className={
                  'rounded-full px-3 py-1.5 text-xs font-bold transition-colors ' +
                  (tab === id
                    ? 'bg-white text-[--color-brand-700] shadow-sm'
                    : 'text-[--color-ink-soft] hover:text-[--color-ink]')
                }
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            {tab === 'apikey' ? (
              <div className="relative">
                <Input
                  label="API Key"
                  name="apikey"
                  type={showSecret ? 'text' : 'password'}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="ndk_xxxxxxxxxx_yyyyyyyy…"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  className="pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2.5 bottom-2.5 rounded-full p-1 text-[--color-ink-faint] transition-colors hover:text-[--color-ink]"
                  aria-label={showSecret ? '隐藏' : '显示'}
                >
                  <Icon d={showSecret ? ICONS.eyeOff : ICONS.eye} className="size-4" />
                </button>
              </div>
            ) : (
              <Input
                label="登录密钥"
                name="password"
                type="password"
                value={loginInput}
                onChange={(e) => setLoginInput(e.target.value)}
                placeholder="NETDISK_KEY 的值"
                autoComplete="current-password"
                autoFocus
              />
            )}

            {shownError && (
              <div className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs leading-snug text-rose-700">
                <Icon d={ICONS.info} className="mt-px size-3.5 shrink-0" />
                <span className="break-words">{shownError}</span>
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              {busy ? '连接中…' : '连接'}
            </Button>
          </form>

          <p className="mt-4 text-[11px] leading-relaxed text-[--color-ink-faint]">
            {tab === 'apikey'
              ? 'API Key 保存在本机浏览器，之后所有请求自动携带，不会上传到任何第三方。'
              : '登录密钥用于换取临时凭证。服务重启后需要重新登录。'}
          </p>
        </div>

        {/* 后端地址，便于排查配置问题 */}
        <p className="mt-4 text-center text-[11px] text-[--color-ink-faint]">
          后端：
          <code className="ml-1 rounded bg-white/70 px-1.5 py-0.5 font-mono">
            {API_BASE || window.location.origin}
          </code>
        </p>
      </div>
    </div>
  )
}
