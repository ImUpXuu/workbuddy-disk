/**
 * 连接后端页。
 *
 * 两条路径：填 API Key（主通道，存 localStorage）/ 填登录密钥（换临时 token）。
 * 前后端不同源，凭证一律落在 localStorage，不用 Cookie。
 *
 * 视觉：标准对话框，不做居中大卡片 + 装饰图标，信息优先。
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
        useApiKey(value)
        const res = await api.whoami()
        if (!res.authenticated) throw new ApiError('unauthorized', 'API Key 无效或已被停用')
        toast.success('已连接', 'API Key 已保存到本机')
      } else {
        await loginWithKey(value)
        toast.success('登录成功')
      }
    } catch (err) {
      setLocalError(err instanceof ApiError ? err.friendly : (err as Error).message)
      if (tab === 'apikey') useApiKey('')
    } finally {
      setBusy(false)
    }
  }

  const shownError = localError || authError

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[--color-canvas] px-4 py-10">
      <div className="win-panel w-full max-w-[420px]">
        {/* 标题栏 */}
        <div className="flex items-center gap-2.5 border-b border-[--color-line] px-5 py-3.5">
          <Icon d={ICONS.drive} className="size-5 text-[--color-accent]" strokeWidth={1.8} />
          <div className="min-w-0">
            <h1 className="text-[14px] font-semibold text-[--color-ink]">WorkBuddy Disk</h1>
            <p className="text-[11.5px] text-[--color-ink-soft]">连接到你的文件服务器</p>
          </div>
        </div>

        <div className="px-5 py-4">
          {/* 通道切换：下划线标签，不是胶囊 */}
          <div className="mb-4 flex gap-5 border-b border-[--color-line]">
            {([
              ['apikey', 'API Key'],
              ['login', '登录密钥'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => { setTab(id); setLocalError('') }}
                className={cn(
                  '-mb-px border-b-2 px-0.5 pb-2 text-[12.5px] transition-colors',
                  tab === id
                    ? 'border-[--color-accent] font-semibold text-[--color-accent]'
                    : 'border-transparent text-[--color-ink-soft] hover:text-[--color-ink]',
                )}
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
                  className="!pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2.5 bottom-2 text-[--color-ink-faint] hover:text-[--color-ink]"
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
              <div className="flex items-start gap-2 border border-[#e8b3ad] bg-[--color-danger-soft] px-3 py-2 text-xs leading-snug text-[--color-danger]">
                <Icon d={ICONS.info} className="mt-px size-3.5 shrink-0" />
                <span className="break-words">{shownError}</span>
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full !py-2">
              {busy ? '连接中…' : '连接'}
            </Button>
          </form>

          <p className="mt-3.5 text-[11.5px] leading-relaxed text-[--color-ink-soft]">
            {tab === 'apikey'
              ? 'API Key 保存在本机浏览器，之后所有请求自动携带，不会上传到任何第三方。'
              : '登录密钥用于换取临时凭证。服务重启后需要重新登录。'}
          </p>
        </div>

        <div className="border-t border-[--color-line] bg-[--color-surface-alt] px-5 py-2.5 text-[11px] text-[--color-ink-faint]">
          后端：<code className="ml-1 font-mono text-[--color-ink-soft]">{API_BASE || window.location.origin}</code>
        </div>
      </div>
    </div>
  )
}
