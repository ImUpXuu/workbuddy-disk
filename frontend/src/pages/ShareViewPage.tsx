/**
 * 公开分享查看页（免登录）。
 *
 * 凭链接里的 token 直接访问：
 *   - 目录分享：浏览整个子树，点文件夹下钻，点文件预览（图片/视频内联），下载走显式按钮
 *   - 文件分享：展示该文件，可直接预览 / 下载（图片、视频内联）
 *
 * 不依赖登录态，任何人拿到链接都能打开。
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { Entry, PublicShareResponse } from '../types/api'
import { useToast } from '../context/ToastContext'
import { navigate, parseHash, shareNavigate, useHashRoute } from '../lib/router'
import { cn, humanSize, humanDate, isVideo, kindOf } from '../lib/utils'
import { Button, Icon, ICONS } from '../components/ui'

/** 类型 → emoji 字形（与文件列表保持一致风格） */
const KIND_GLYPH: Record<string, string> = {
  folder: '📁',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  archive: '🗜️',
  document: '📄',
  code: '📜',
  apk: '📦',
  font: '🔤',
  file: '🗂️',
}

export default function ShareViewPage() {
  const toast = useToast()
  const [route, setRoute] = useState(() => parseHash())
  const [data, setData] = useState<PublicShareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Entry | null>(null)

  // 跟随 hash 变化（分享内下钻 / 浏览器前进后退）
  useHashRoute((r) => {
    if (r.view === 'share') setRoute(r)
  })

  const token = route.token
  const sub = route.sharePath

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const res = await api.getPublicShare(token, sub)
      setData(res)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.kind === 'notfound') setError('链接不存在或已失效')
        else setError(err.friendly)
      } else {
        setError('加载失败')
      }
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [token, sub])

  useEffect(() => {
    void load()
  }, [load])

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
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => navigate({ view: 'disk' })}
            className="flex min-w-0 items-center gap-2 text-base font-black text-[--color-sky-600] transition-opacity hover:opacity-80 sm:text-lg"
            aria-label="回到网盘"
          >
            <Icon d={ICONS.cloud} className="size-5 shrink-0 text-[--color-sky-400]" strokeWidth={2} />
            <span className="truncate-1">WorkBuddy Disk</span>
          </button>
          <span className="chip ml-auto hidden border-2 border-emerald-200 bg-emerald-50 text-emerald-600 sm:inline-flex">
            公开分享
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-10 sm:px-4">
        {loading ? (
          <div className="space-y-2 py-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        ) : error ? (
          <div className="cute-border mt-6 rounded-2xl bg-white p-10 text-center">
            <div className="mb-2 text-4xl opacity-50">🔗</div>
            <p className="text-base font-black text-slate-700">{error}</p>
            <p className="mt-1 text-xs font-medium text-slate-400">
              链接可能已被撤销、停用或已过期
            </p>
          </div>
        ) : (
          data && (
            <ShareBody
              data={data}
              onOpenDir={(p) => shareNavigate(token, p)}
              onPreview={setPreview}
              onDownload={downloadFile}
            />
          )
        )}
        {preview && (
          <SharePreview
            entry={preview}
            token={token}
            onClose={() => setPreview(null)}
            onDownload={(e) => {
              setPreview(null)
              void downloadFile(e)
            }}
          />
        )}
      </main>
    </div>
  )
}

function ShareBody({
  data,
  onOpenDir,
  onPreview,
  onDownload,
}: {
  data: PublicShareResponse
  onOpenDir: (relPath: string) => void
  onPreview: (entry: Entry) => void
  onDownload: (entry: Entry) => void
}) {
  // 文件分享：展示单个文件 + 预览 / 下载
  if (!data.is_dir && data.file) {
    const f = data.file
    const previewUrl = api.shareDownloadUrl(data.token, f.path)
    const canPreview = /^(image|video)/.test(kindOf(f.name, false))
    return (
      <div className="mt-6">
        <div className="cute-border rounded-2xl bg-white p-5">
          <div className="flex items-center gap-3">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-slate-100 text-2xl">
              {KIND_GLYPH[kindOf(f.name, false)] ?? KIND_GLYPH.file}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate-1 text-sm font-black text-slate-800">{f.name}</p>
              <p className="mt-0.5 text-[11px] font-medium text-[--color-ink-faint]">
                {humanSize(f.size)} · {humanDate(f.mtime)}
              </p>
            </div>
          </div>

          {canPreview && (
            <div className="mt-4 overflow-hidden rounded-xl bg-slate-50">
              {isVideo(f.name) ? (
                <video src={previewUrl} controls className="max-h-[60vh] w-full bg-black" />
              ) : (
                <img src={previewUrl} alt={f.name} className="max-h-[60vh] w-full object-contain" />
              )}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => void onDownload(f)}
              icon={<Icon d={ICONS.download} className="size-3.5" />}
            >
              下载文件
            </Button>
          </div>
        </div>
        <p className="mt-3 text-center text-xs font-medium text-slate-400">
          这是一条公开分享链接，任何拿到链接的人都能下载
        </p>
      </div>
    )
  }

  // 目录分享：面包屑 + 列表
  return (
    <div className="mt-4">
      {/* 面包屑 */}
      <nav className="mb-3 flex items-center gap-1 overflow-x-auto text-sm" aria-label="分享路径">
        <button
          type="button"
          onClick={() => onOpenDir(data.root_path)}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full border-2 px-2.5 py-1 font-bold transition-colors',
            data.path === data.root_path
              ? 'border-[--color-sky-400] bg-[--color-sky-100] text-[--color-sky-700]'
              : 'border-transparent text-[--color-ink-soft] hover:border-[--color-sky-200] hover:text-[--color-sky-600]',
          )}
        >
          <Icon d={ICONS.home} className="size-3.5" />
          {data.root_name || '根目录'}
        </button>
        {data.crumbs.map((c) => (
          <span key={c.path} className="flex min-w-0 shrink-0 items-center gap-1">
            <span className="text-slate-300" aria-hidden>
              /
            </span>
            <button
              type="button"
              onClick={() => onOpenDir(c.path)}
              className={cn(
                'truncate-1 max-w-[10rem] rounded-full border-2 px-2.5 py-1 font-bold transition-colors',
                c.path === data.path
                  ? 'border-[--color-sky-400] bg-[--color-sky-100] text-[--color-sky-700]'
                  : 'border-transparent text-[--color-ink-soft] hover:border-[--color-sky-200] hover:text-[--color-sky-600]',
              )}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      <h2 className="mb-3 flex items-center gap-2 px-1 text-xl font-black text-slate-800">
        <Icon d={ICONS.folder} className="size-5 text-[--color-sky-400]" strokeWidth={2.2} />
        {data.name || '根目录'}
      </h2>

      {data.items.length === 0 ? (
        <div className="cute-border rounded-2xl bg-white p-10 text-center">
          <div className="mb-2 text-3xl opacity-50">📂</div>
          <p className="text-sm font-bold text-slate-500">这个文件夹是空的</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.items.map((entry) => (
            <ShareItem
              key={entry.path}
              entry={entry}
              token={data.token}
              onOpenDir={onOpenDir}
              onPreview={onPreview}
              onDownload={onDownload}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ShareItem({
  entry,
  token,
  onOpenDir,
  onPreview,
  onDownload,
}: {
  entry: Entry
  token: string
  onOpenDir: (relPath: string) => void
  onPreview: (entry: Entry) => void
  onDownload: (entry: Entry) => void
}) {
  const kind = kindOf(entry.name, entry.is_dir)
  const thumb = hasThumb(kind) ? api.shareThumbnailUrl(token, entry.path) : null

  return (
    <li className="cute-border flex items-center gap-3 rounded-2xl bg-white px-3 py-2.5">
      <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 text-lg">
        {thumb ? (
          <img src={thumb} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden>{KIND_GLYPH[kind] ?? KIND_GLYPH.file}</span>
        )}
      </div>

      <button
        type="button"
        onClick={() => (entry.is_dir ? onOpenDir(entry.path) : onPreview(entry))}
        className="min-w-0 flex-1 text-left"
      >
        <p className="truncate-1 text-sm font-bold text-[--color-ink]">{entry.name}</p>
        <p className="mt-0.5 flex items-center gap-2 text-[11px] font-medium text-[--color-ink-faint]">
          <span className="truncate-1">{humanDate(entry.mtime)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{entry.is_dir ? '文件夹' : entry.size_h}</span>
        </p>
      </button>

      {!entry.is_dir && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => void onDownload(entry)}
          icon={<Icon d={ICONS.download} className="size-3.5" />}
        >
          下载
        </Button>
      )}
    </li>
  )
}

function hasThumb(kind: string): boolean {
  return kind === 'image' || kind === 'video'
}

/**
 * 分享内的文件预览弹层。
 *
 * 点文件名不再直接下载，而是先在这里预览：
 *   - 图片 / 视频：浏览器内联展示
 *   - 其他类型：提示暂不支持在线预览，并提供下载入口
 * 真正的下载交给显式的「下载文件」按钮，避免「一进分享页就全下下来」。
 */
function SharePreview({
  entry,
  token,
  onClose,
  onDownload,
}: {
  entry: Entry
  token: string
  onClose: () => void
  onDownload: (entry: Entry) => void
}) {
  const kind = kindOf(entry.name, false)
  const src = api.shareDownloadUrl(token, entry.path)

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="cute-border w-full max-w-2xl rounded-2xl bg-white p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate-1 text-sm font-black text-slate-800">{entry.name}</p>
            <p className="mt-0.5 text-[11px] font-medium text-[--color-ink-faint]">
              {humanSize(entry.size)} · {humanDate(entry.mtime)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <Icon d={ICONS.close} className="size-4" />
          </button>
        </div>

        <div className="overflow-hidden rounded-xl bg-slate-50">
          {kind === 'image' ? (
            <img src={src} alt={entry.name} className="max-h-[60vh] w-full bg-[#0b0b0c] object-contain" />
          ) : kind === 'video' ? (
            <video src={src} controls className="max-h-[60vh] w-full bg-black" />
          ) : (
            <div className="grid place-items-center p-10 text-center">
              <div className="mb-2 text-4xl opacity-50">{KIND_GLYPH[kind] ?? KIND_GLYPH.file}</div>
              <p className="text-sm font-bold text-slate-500">该类型暂不支持在线预览</p>
              <p className="mt-1 text-xs font-medium text-slate-400">点「下载文件」保存到本地</p>
            </div>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => void onDownload(entry)}
            icon={<Icon d={ICONS.download} className="size-3.5" />}
          >
            下载文件
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  )
}
