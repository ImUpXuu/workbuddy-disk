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
import { cn } from '../lib/utils'

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
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="icon-disc size-16">
            <Icon d={ICONS.cloud} className="size-8 text-[--color-sky-500]" strokeWidth={2} />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-[--color-sky-600]">
            WorkBuddy Disk
          </h1>
          <p className="text-xs font-bold tracking-wide text-slate-400">轻量自托管网盘</p>
        </div>

        {/* 表单卡片：笔绘风 */}
        <div className="cute-border p-5">
          {/* 通道切换 */}
          <div className="mb-4 flex gap-2">
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
                className={cn(
                  'flex-1 rounded-full border-2 px-3 py-1.5 text-xs font-bold transition-colors',
                  tab === id
                    ? 'border-[--color-sky-400] bg-[--color-sky-400] text-white'
                    : 'border-[--color-sky-200] bg-white text-[--color-sky-600] hover:border-[--color-sky-400]',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                  className="absolute right-3 bottom-2.5 text-[--color-ink-faint] transition-colors hover:text-[--color-sky-600]"
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
              <div className="flex items-start gap-2 rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-snug font-bold text-red-700">
                <Icon d={ICONS.info} className="mt-px size-3.5 shrink-0" />
                <span className="break-words">{shownError}</span>
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full !py-2.5">
              {busy ? '连接中…' : '连接'}
            </Button>
          </form>

          <p className="mt-4 text-[11px] leading-relaxed font-medium text-slate-400">
            {tab === 'apikey'
              ? 'API Key 保存在本机浏览器，之后所有请求自动携带，不会上传到任何第三方。'
              : '登录密钥用于换取临时凭证。服务重启后需要重新登录。'}
          </p>
        </div>

        {/* 后端地址 */}
        <p className="mt-5 text-center text-[11px] font-medium text-slate-400">
          后端：
          <code className="ml-1 rounded-md bg-white px-1.5 py-0.5 font-mono">
            {API_BASE || window.location.origin}
          </code>
        </p>
      </div>
    </div>
  )
}
