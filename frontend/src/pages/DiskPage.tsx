/**
 * 主界面：顶栏 + 文件浏览器。
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
      {/* ═══ 顶栏 ═══
          品牌字样沿用参考站点的实现：纯文字链接（不是胶囊按钮），
          `text-2xl font-black text-[#0284c7] hover:opacity-80`，点击回根目录。 */}
      <header className="sticky top-0 z-30 bg-[--color-canvas]">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-4">
          <button
            type="button"
            onClick={() => setPath('')}
            className="flex min-w-0 items-center gap-2 text-xl font-black text-[--color-sky-600] transition-opacity hover:opacity-80 sm:text-2xl"
            aria-label="回到根目录"
          >
            <Icon
              d={ICONS.cloud}
              className="size-6 shrink-0 text-[--color-sky-400] sm:size-7"
              strokeWidth={2}
            />
            <span className="truncate-1">WorkBuddy Disk</span>
          </button>

          {/* 当前鉴权方式：参考站点的描边 chip 语言 */}
          <span className="chip hidden border-2 border-[--color-sky-200] bg-white text-[--color-sky-600] sm:inline-flex">
            {mode === 'apikey' ? 'API Key' : '会话'}
          </span>

          <Button
            onClick={logout}
            size="sm"
            className="ml-auto"
            icon={<Icon d={ICONS.logout} className="size-3.5" />}
          >
            退出
          </Button>
        </div>
      </header>

      {/* ═══ 主体 ═══ */}
      <main className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col px-3 pb-2 sm:px-4">
        <div className="cute-border flex min-h-0 flex-1 flex-col overflow-hidden">
          <FileBrowser onPathChange={handlePathChange} />
        </div>
      </main>

      {/* ═══ 页脚 ═══ */}
      <footer className="mx-auto w-full max-w-5xl px-4 pt-4 pb-8 text-center">
        <p className="text-xs font-bold tracking-wide text-slate-400">
          {path ? `/${path}` : '根目录'}
        </p>
        <p className="mt-1 text-xs font-bold text-slate-400">
          WorkBuddy Disk · 前端 Vercel / 后端自托管
        </p>
      </footer>
    </div>
  )
}
