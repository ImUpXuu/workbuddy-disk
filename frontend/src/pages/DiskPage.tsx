/**
 * 主界面：顶栏 + 文件浏览器 + 上传面板。
 *
 * 上传的接线都在这里：
 *   - 隐藏的 file input（「上传」按钮点击它）
 *   - 拖拽投放区包裹文件列表
 *   - 右下角进度面板
 *   - 引擎配置注入（并发数从后端设置读）
 *   - 上传完成后刷新当前目录
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
import { Button, Icon, ICONS } from '../components/ui'

/** 上传完成后的列表刷新去抖窗口（毫秒） */
const REFRESH_DEBOUNCE_MS = 400

export default function DiskPage() {
  const { logout, mode } = useAuth()
  const toast = useToast()
  const [path, setPath] = useState('')

  const uploading = useIsUploading()
  const { addFiles, configure, onTaskDone } = useUploadActions()

  // 上传中刷新/关闭页面会丢进度，拦一下
  useUploadUnloadGuard()

  const browserRef = useRef<FileBrowserHandle>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handlePathChange = useCallback((p: string) => setPath(p), [])

  // 拖拽投放要拿「此刻」的目录，不能用闭包里的 path
  const getTargetPath = useCallback(() => browserRef.current?.currentPath() ?? '', [])

  // ── 注入引擎配置：并发数来自后端，阈值与上限来自列表接口 ──
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [settings, list] = await Promise.all([api.getSettings(), api.list('')])
        if (!alive) return
        configure({
          // 并发数由后端设置决定（1~10）
          concurrency: settings.settings?.upload_concurrency ?? 3,
          // 阈值/上限以后端下发为准，缺失时用保守默认
          chunkThreshold: list.chunk_threshold ?? 48 * 1024 * 1024,
          maxFileSize: list.max_file_size ?? 2 * 1024 * 1024 * 1024,
          // 分片大小固定用 8MB，主动小于后端默认的 48MB ——
          // 网关请求体上限约 50MB，48MB 贴得太紧
          chunkSize: DEFAULT_UPLOAD_CHUNK_SIZE,
        })
      } catch {
        /* 拉配置失败就用引擎默认值，不影响上传可用性 */
      }
    })()
    return () => {
      alive = false
    }
  }, [configure])

  // ── 上传完成 → 刷新列表 ──
  //
  // 两个关键点：
  //   1. 去抖：并发上传 10 个文件不能打 10 次 list 请求
  //   2. 区分目录：上传目标是「发起时所在目录」，刷新目标是「当前目录」。
  //      两者不同时刷新当前列表没意义（用户看不到），改为 toast 告知。
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () =>
      onTaskDone(({ task, renamed }) => {
        if (renamed) {
          toast.warning('文件已自动改名', `同名文件已存在，保存为「${task.name}」`)
        }

        const current = browserRef.current?.currentPath() ?? ''
        // 文件夹上传时文件可能落在 targetPath 的子目录里，
        // 而列表不递归，所以「看不到新文件」是正常的 —— 提示里带上完整路径。
        if (task.targetPath !== current) {
          const where = task.dirmode && task.relPath
            ? task.relPath
            : task.targetPath || '根目录'
          toast.info(`「${task.finalName || task.name}」已上传到 ${where}`)
          return
        }

        if (refreshTimer.current) return // 去抖窗口内已有待执行的刷新
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null
          browserRef.current?.reload()
        }, REFRESH_DEBOUNCE_MS)
      }),
    [onTaskDone, toast],
  )

  // 最后一个任务结束时立即再刷一次 —— 防止它的完成事件被去抖窗口吞掉
  useEffect(() => {
    if (uploading) return
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
      browserRef.current?.reload()
    }
  }, [uploading])

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [])

  // ── 文件选择 ──
  const requestUpload = useCallback(() => inputRef.current?.click(), [])

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      // 目标目录 = 点「上传」时所在目录
      if (files.length) addFiles(files, getTargetPath())
      // 清空，否则再次选择同一文件不会触发 change
      e.target.value = ''
    },
    [addFiles, getTargetPath],
  )

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
        {/* 隐藏的文件选择器，整页共用一个 */}
        <input ref={inputRef} type="file" multiple hidden onChange={onPick} />

        <div className="cute-border flex min-h-0 flex-1 flex-col overflow-hidden">
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

      {/* ═══ 页脚 ═══ */}
      <footer className="mx-auto w-full max-w-5xl px-4 pt-4 pb-8 text-center">
        <p className="text-xs font-bold tracking-wide text-slate-400">
          {path ? `/${path}` : '根目录'}
        </p>
        <p className="mt-1 text-xs font-bold text-slate-400">
          WorkBuddy Disk · 前端 Vercel / 后端自托管
        </p>
      </footer>

      {/* ═══ 上传进度面板（右下角）═══ */}
      <UploadPanel />
    </div>
  )
}
