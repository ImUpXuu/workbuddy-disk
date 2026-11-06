/**
 * 公开分享查看页（免登录）—— 与主界面同一套紧凑表格视图。
 *
 *   - 目录分享：浏览整个子树，点文件夹下钻，点文件预览（图片/视频内联），
 *     下载走显式按钮，避免「一进分享页就全下下来」
 *   - 文件分享：展示该文件 + 预览 / 下载
 *
 * 不依赖登录态，任何人拿到链接都能打开。
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { Entry, PublicShareResponse } from '../types/api'
import { useToast } from '../context/ToastContext'
import { buildBreadcrumb, cn, fileIconOf, fileIconTone, humanDate, humanSize, kindLabel } from '../lib/utils'
import { shareNavigate, useHashRoute, parseHash } from '../lib/router'
import { Button, EmptyState, Icon, ICONS, SkeletonRows } from '../components/ui'

export default function ShareViewPage() {
  const toast = useToast()
  const [route, setRoute] = useState(() => parseHash())
  const [data, setData] = useState<PublicShareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Entry | null>(null)

  useHashRoute((r) => { if (r.view === 'share') setRoute(r) })

  const token = route.token
  const sub = route.sharePath

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      setData(await api.getPublicShare(token, sub))
    } catch (err) {
      setError(err instanceof ApiError
        ? (err.kind === 'notfound' ? '链接不存在或已失效' : err.friendly)
        : '加载失败')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [token, sub])

  useEffect(() => { void load() }, [load])

  async function downloadFile(entry: Entry) {
    const id = toast.info(`开始下载 ${entry.name}`, '准备中…')
    try {
      await api.shareDownload(token, entry.path, entry.name, (loaded, total) => {
        if (!total) return
        const pct = Math.round((loaded / total) * 100)
        toast.dismiss(id)
        if (pct < 100) toast.info(`下载中 ${pct}%`, entry.name)
      })
      toast.success('下载完成', entry.name)
    } catch (err) {
      toast.error('下载失败', err instanceof ApiError ? err.friendly : '请重试')
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[--color-canvas]">
      {/* 标题栏 */}
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-[--color-line] bg-white px-3">
        <Icon d={ICONS.link} className="size-4 text-[--color-accent]" />
        <span className="text-[13px] font-semibold text-[--color-ink]">WorkBuddy Disk</span>
        <span className="chip border border-emerald-200 bg-emerald-50 text-[--color-success]">公开分享</span>
        <span className="ml-auto text-[11.5px] text-[--color-ink-faint]">无需登录即可访问</span>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-2 max-sm:p-0">
        <div className="win-panel mx-auto flex min-h-0 max-w-6xl flex-col overflow-hidden">
          {loading ? (
            <SkeletonRows rows={8} />
          ) : error ? (
            <EmptyState icon={ICONS.link} title={error} hint="链接可能已被撤销、停用或已过期" />
          ) : data && (
            <ShareBody data={data} onOpenDir={(p) => shareNavigate(token, p)} onPreview={setPreview} onDownload={downloadFile} />
          )}
        </div>
      </main>

      {data && (
        <div className="win-statusbar">
          <span>{data.is_dir ? `${data.items.length} 个项目` : '1 个文件'}</span>
          <span className="sep">|</span>
          <span className="truncate-1">{data.is_dir ? (data.path || data.root_name) : data.name}</span>
          <span className="ml-auto">公开链接，任何拿到的人都能查看与下载</span>
        </div>
      )}

      {preview && (
        <SharePreview
          entry={preview}
          token={token}
          onClose={() => setPreview(null)}
          onDownload={(e) => { setPreview(null); void downloadFile(e) }}
        />
      )}
    </div>
  )
}

function ShareBody({
  data, onOpenDir, onPreview, onDownload,
}: {
  data: PublicShareResponse
  onOpenDir: (relPath: string) => void
  onPreview: (entry: Entry) => void
  onDownload: (entry: Entry) => void
}) {
  // 文件分享：单个文件 + 预览 / 下载
  if (!data.is_dir && data.file) {
    const f = data.file
    const src = api.shareDownloadUrl(data.token, f.path)
    const isImg = /\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)$/i.test(f.name)
    const isVid = /\.(mp4|webm|mkv|mov|m4v)$/i.test(f.name)
    return (
      <div className="p-4">
        <div className="win-panel p-4">
          <div className="flex items-center gap-3">
            <div className="icon-disc size-10">
              <Icon d={fileIconOf(f.name, false)} className={cn('size-5', fileIconTone(f.name, false))} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate-1 text-[13px] font-semibold text-[--color-ink]">{f.name}</p>
              <p className="mt-0.5 text-[11.5px] text-[--color-ink-faint]">
                {kindLabel(f.name, false)} · {humanSize(f.size)} · {humanDate(f.mtime)}
              </p>
            </div>
          </div>

          {isImg && (
            <div className="mt-3 overflow-hidden rounded border border-[--color-line] bg-[#f7f8fa] p-2">
              <img src={src} alt={f.name} className="max-h-[55vh] w-full object-contain" />
            </div>
          )}
          {isVid && (
            <div className="mt-3 overflow-hidden rounded border border-[--color-line] bg-black">
              <video src={src} controls className="max-h-[55vh] w-full" />
            </div>
          )}
          {!isImg && !isVid && (
            <p className="mt-3 text-[12px] text-[--color-ink-soft]">此格式不支持在线预览，可下载到本地查看。</p>
          )}

          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void onDownload(f)} icon={<Icon d={ICONS.download} className="size-3.5" />}>
              下载文件
            </Button>
          </div>
        </div>
        <p className="mt-2 text-center text-[11.5px] text-[--color-ink-faint]">
          这是一条公开分享链接，任何拿到链接的人都能下载
        </p>
      </div>
    )
  }

  // 目录分享：面包屑地址栏 + 表格
  const crumb = buildBreadcrumb(data.path)

  return (
    <>
      <div className="win-address">
        <Icon d={ICONS.folder} className="size-4 shrink-0 text-amber-600" />
        <div className="win-crumbs !cursor-default">
          <button type="button" className={cn('win-crumb', data.path === data.root_path && 'is-current')} onClick={() => onOpenDir(data.root_path)}>
            {data.root_name || '分享根目录'}
          </button>
          {crumb.filter((c) => c.path !== data.root_path).map((c) => (
            <span key={c.path} className="contents">
              <span className="win-crumb-sep">›</span>
              <button type="button" className={cn('win-crumb', c.path === data.path && 'is-current')} onClick={() => onOpenDir(c.path)}>
                {c.name}
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="win-table min-h-0 flex-1 overflow-auto">
        <div className="win-thead">
          <div />
          <div className="win-th !cursor-default">名称</div>
          <div className="win-th win-hide-md !cursor-default">修改日期</div>
          <div className="win-th win-hide-md !cursor-default">类型</div>
          <div className="win-th win-hide-sm !cursor-default justify-end">大小</div>
          <div className="win-th !cursor-default justify-end">操作</div>
        </div>

        {data.items.length === 0 ? (
          <EmptyState icon={ICONS.folder} title="此文件夹为空" hint="分享者还没有在这里放文件" />
        ) : (
          data.items.map((entry) => (
            <div key={entry.path} className="win-row">
              <div />
              <div className="win-td is-name flex min-w-0 items-center gap-2">
                {hasThumb(entry) ? (
                  <img src={api.shareThumbnailUrl(data.token, entry.path)} alt="" className="size-5 shrink-0 rounded-sm object-cover" />
                ) : (
                  <Icon d={fileIconOf(entry.name, entry.is_dir)} className={cn('size-4 shrink-0', fileIconTone(entry.name, entry.is_dir))} />
                )}
                <button
                  type="button"
                  onClick={() => (entry.is_dir ? onOpenDir(entry.path) : onPreview(entry))}
                  className="min-w-0 truncate-1 text-left text-[12.5px] text-[--color-ink] hover:underline"
                  title={entry.name}
                >
                  {entry.name}
                </button>
              </div>
              <div className="win-td win-hide-md">{humanDate(entry.mtime)}</div>
              <div className="win-td win-hide-md">{kindLabel(entry.name, entry.is_dir)}</div>
              <div className="win-td win-hide-sm is-num">{entry.is_dir ? '' : entry.size_h}</div>
              <div className="win-td is-actions">
                {!entry.is_dir && (
                  <>
                    <button type="button" className="win-row-btn" title="预览" aria-label="预览" onClick={() => onPreview(entry)}>
                      <Icon d={ICONS.eye} className="size-3.5" />
                    </button>
                    <button type="button" className="win-row-btn" title="下载" aria-label="下载" onClick={() => void onDownload(entry)}>
                      <Icon d={ICONS.download} className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function hasThumb(entry: Entry): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp|avif|mp4|webm|mkv|mov|m4v)$/i.test(entry.name)
}

/**
 * 分享内的文件预览：点文件名先预览，真正的下载交给显式按钮。
 */
function SharePreview({
  entry, token, onClose, onDownload,
}: {
  entry: Entry
  token: string
  onClose(): void
  onDownload(entry: Entry): void
}) {
  const src = api.shareDownloadUrl(token, entry.path)
  const isImg = /\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)$/i.test(entry.name)
  const isVid = /\.(mp4|webm|mkv|mov|m4v)$/i.test(entry.name)

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden />
      <div className="relative flex w-full max-w-3xl flex-col border border-[--color-line-strong] bg-white shadow-[--shadow-cute-lg]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[--color-line] px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate-1 text-[13px] font-semibold text-[--color-ink]">{entry.name}</p>
            <p className="text-[11px] text-[--color-ink-faint]">{kindLabel(entry.name, false)} · {humanSize(entry.size)} · {humanDate(entry.mtime)}</p>
          </div>
          <button type="button" onClick={onClose} className="win-nav-btn" aria-label="关闭">
            <Icon d={ICONS.close} className="size-3.5" />
          </button>
        </header>

        <div className="min-h-0 overflow-auto bg-[#f7f8fa] p-3">
          {isImg ? (
            <img src={src} alt={entry.name} className="mx-auto max-h-[60vh] object-contain" />
          ) : isVid ? (
            <video src={src} controls className="mx-auto max-h-[60vh] w-full bg-black" />
          ) : (
            <div className="py-14 text-center">
              <Icon d={fileIconOf(entry.name, false)} className="mx-auto size-10 text-[--color-ink-faint]" />
              <p className="mt-3 text-[12.5px] font-semibold text-[--color-ink]">此格式不支持在线预览</p>
              <p className="mt-1 text-[11.5px] text-[--color-ink-soft]">点「下载文件」保存到本地查看</p>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[--color-line] bg-[--color-surface-alt] px-4 py-2.5">
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={() => void onDownload(entry)} icon={<Icon d={ICONS.download} className="size-3.5" />}>
            下载文件
          </Button>
        </footer>
      </div>
    </div>
  )
}
