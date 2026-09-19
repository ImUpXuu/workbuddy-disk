/**
 * 主界面：顶栏 + 文件浏览器。
 *
 * 阶段三先做只读与基础写操作，上传与设置后续接入。
 */

import { useCallback, useState } from 'react'
import FileBrowser from '../components/FileBrowser'
import { useAuth } from '../context/AuthContext'
import { Button, Icon, ICONS } from '../components/ui'

export default function DiskPage() {
  const { logout, mode } = useAuth()
  const [path, setPath] = useState('')

  const handlePathChange = useCallback((p: string) => setPath(p), [])

  return (
    <div className="flex min-h-dvh flex-col">
      {/* ═══ 顶栏 ═══ */}
      <header className="sticky top-0 z-30 border-b border-white/60 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[--color-brand-500] text-white shadow-[0_6px_16px_-6px_rgb(14_165_233/0.7)]">
              <Icon d={ICONS.cloud} className="size-5" strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate-1 text-sm leading-tight font-extrabold tracking-tight">
                WorkBuddy Disk
              </h1>
              <p className="truncate-1 text-[11px] leading-tight text-[--color-ink-faint]">
                {path ? `/${path}` : '根目录'}
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <span
              className="chip hidden bg-[--color-brand-100] text-[--color-brand-700] sm:inline-flex"
              title={mode === 'apikey' ? '当前使用 API Key' : '当前使用登录凭证'}
            >
              {mode === 'apikey' ? 'API Key' : '会话'}
            </span>

            <Button
              onClick={logout}
              icon={<Icon d={ICONS.logout} className="size-3.5" />}
              className="!px-3 !py-1.5 !text-xs"
            >
              退出
            </Button>
          </div>
        </div>
      </header>

      {/* ═══ 主体 ═══ */}
      <main className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-2 py-3 sm:px-4">
        <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
          <FileBrowser onPathChange={handlePathChange} />
        </div>
      </main>

      {/* ═══ 页脚 ═══ */}
      <footer className="px-4 pb-4 text-center text-[11px] text-[--color-ink-faint]">
        WorkBuddy Disk · 前端 Vercel / 后端自托管
      </footer>
    </div>
  )
}
