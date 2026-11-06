/**
 * 主界面：窗口式外壳 —— 标题栏 + 左侧导航 + 全宽文件区。
 *
 * 上传接线都在这里（隐藏 file input / 拖拽投放 / 进度面板 / 引擎配置 /
 * 完成后刷新），与视图重写无关，保持原样。
 *
 * 布局不再用居中卡片：内容区铺满可用宽度，信息密度优先。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import FileBrowser, { type FileBrowserHandle } from '../components/FileBrowser'
import UploadDropZone from '../components/UploadDropZone'
import UploadPanel from '../components/UploadPanel'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useIsUploading, useUploadActions, useUploadUnloadGuard } from '../hooks/useUpload'
import { api } from '../api/client'
import { DEFAULT_UPLOAD_CHUNK_SIZE } from '../lib/uploadEngine'
import { navigate } from '../lib/router'
import { Button, Icon, ICONS } from '../components/ui'
import WebDavModal from '../components/WebDavModal'
import { humanSize } from '../lib/utils'

const REFRESH_DEBOUNCE_MS = 400

export default function DiskPage() {
  const { logout, mode } = useAuth()
  const toast = useToast()
  const [path, setPath] = useState('')
  const [stats, setStats] = useState<{ files: number; dirs: number; size: number } | null>(null)
  const [webdavOpen, setWebDavOpen] = useState(false)

  const uploading = useIsUploading()
  const { addFiles, configure, onTaskDone } = useUploadActions()
  useUploadUnloadGuard()

  const browserRef = useRef<FileBrowserHandle>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handlePathChange = useCallback((p: string) => setPath(p), [])
  const getTargetPath = useCallback(() => browserRef.current?.currentPath() ?? '', [])

  // ── 注入引擎配置 ──
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [settings, list] = await Promise.all([api.getSettings(), api.list('')])
        if (!alive) return
        configure({
          concurrency: settings.settings?.upload_concurrency ?? 3,
          chunkThreshold: list.chunk_threshold ?? 48 * 1024 * 1024,
          maxFileSize: list.max_file_size ?? 2 * 1024 * 1024 * 1024,
          chunkSize: DEFAULT_UPLOAD_CHUNK_SIZE,
        })
      } catch { /* 拉配置失败就用引擎默认值 */ }
    })()
    return () => { alive = false }
  }, [configure])

  // ── 侧栏统计 ──
  useEffect(() => {
    let alive = true
    api.stats().then((r) => {
      if (alive) setStats({ files: r.files, dirs: r.dirs, size: r.size })
    }).catch(() => { /* 统计失败不影响主流程 */ })
    return () => { alive = false }
  }, [uploading])

  // ── 上传完成 → 刷新列表（去抖）──
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => onTaskDone(({ task, renamed }) => {
      if (renamed) toast.warning('文件已自动改名', `同名文件已存在，保存为「${task.name}」`)
      const current = browserRef.current?.currentPath() ?? ''
      if (task.targetPath !== current) {
        const where = task.dirmode && task.relPath ? task.relPath : task.targetPath || '根目录'
        toast.info(`「${task.finalName || task.name}」已上传到 ${where}`)
        return
      }
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        browserRef.current?.reload()
      }, REFRESH_DEBOUNCE_MS)
    }),
    [onTaskDone, toast],
  )

  useEffect(() => {
    if (uploading) return
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
      browserRef.current?.reload()
    }
  }, [uploading])

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
  }, [])

  const requestUpload = useCallback(() => inputRef.current?.click(), [])

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length) addFiles(files, getTargetPath())
    e.target.value = ''
  }, [addFiles, getTargetPath])

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[--color-canvas]">
      {/* ═══ 标题栏 ═══ */}
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-[--color-line] bg-white px-3">
        <button
          type="button"
          onClick={() => navigate({ view: 'disk', path: '' })}
          className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[--color-ink] hover:text-[--color-accent]"
          aria-label="回到根目录"
        >
          <Icon d={ICONS.drive} className="size-4 shrink-0 text-[--color-accent]" strokeWidth={1.8} />
          <span className="truncate-1">WorkBuddy Disk</span>
        </button>

        <span className="chip hidden border border-[--color-line] bg-[--color-surface-alt] text-[--color-ink-soft] sm:inline-flex">
          {mode === 'apikey' ? 'API Key' : '会话'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            onClick={() => setWebDavOpen(true)}
            size="sm"
            variant="ghost"
            icon={<Icon d={ICONS.cloud} className="size-3.5" />}
          >
            WebDAV
          </Button>
          <Button
            onClick={() => navigate({ view: 'shares' })}
            size="sm"
            variant="ghost"
            icon={<Icon d={ICONS.users} className="size-3.5" />}
          >
            分享管理
          </Button>
          <Button onClick={logout} size="sm" variant="ghost" icon={<Icon d={ICONS.logout} className="size-3.5" />}>
            退出
          </Button>
        </div>
      </header>

      {/* ═══ 主体：侧栏 + 内容 ═══ */}
      <div className="flex min-h-0 flex-1">
        <aside className="win-sidebar hidden md:block">
          <p className="win-nav-group-title">快速访问</p>
          <button
            type="button"
            className="win-nav-item is-active"
            onClick={() => navigate({ view: 'disk', path: '' })}
          >
            <Icon d={ICONS.drive} className="size-4 shrink-0" />
            此电脑
          </button>
          <button
            type="button"
            className="win-nav-item"
            onClick={() => navigate({ view: 'shares' })}
          >
            <Icon d={ICONS.share} className="size-4 shrink-0" />
            分享管理
          </button>
          <button
            type="button"
            className="win-nav-item"
            onClick={() => setWebDavOpen(true)}
          >
            <Icon d={ICONS.cloud} className="size-4 shrink-0" />
            WebDAV 挂载
          </button>

          <p className="win-nav-group-title">当前位置</p>
          <div className="px-2.5 py-1 text-[11.5px] leading-relaxed break-all text-[--color-ink-soft]">
            {path ? `/${path}` : '根目录'}
          </div>

          <p className="win-nav-group-title">存储</p>
          <div className="px-2.5 py-1 text-[11.5px] leading-relaxed text-[--color-ink-soft]">
            {stats ? (
              <>
                <div>{stats.files} 个文件 · {stats.dirs} 个文件夹</div>
                <div className="mt-0.5 font-semibold text-[--color-ink]">{humanSize(stats.size)} 已用</div>
              </>
            ) : '读取中…'}
          </div>

        </aside>

        <main className="flex min-w-0 min-h-0 flex-1 flex-col p-2 max-sm:p-0">
          <input ref={inputRef} type="file" multiple hidden onChange={onPick} />
          <div className="win-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <UploadDropZone getTargetPath={getTargetPath}>
              <FileBrowser
                ref={browserRef}
                onPathChange={handlePathChange}
                onRequestUpload={requestUpload}
                uploading={uploading}
              />
            </UploadDropZone>
          </div>
        </main>
      </div>

      {/* ═══ 上传进度面板 ═══ */}
      <UploadPanel />

      {/* ═══ WebDAV 连接信息 ═══ */}
      <WebDavModal open={webdavOpen} onClose={() => setWebDavOpen(false)} />
    </div>
  )
}
