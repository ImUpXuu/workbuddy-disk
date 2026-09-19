/**
 * 单个目录项（文件或文件夹）的行。
 *
 * 交互：
 *   - 单击 → 进入目录 / 预览文件
 *   - 悬停显示操作按钮：预览、下载、重命名、删除
 *   - 勾选模式下显示复选框
 *
 * 缩略图与下载都走 Blob（fetch + X-API-Key 头），
 * 不把凭证放进 URL —— 那样会被网关改写，也会泄露到日志与浏览器历史。
 */

import { useEffect, useState } from 'react'
import type { Entry } from '../types/api'
import { api, ApiError } from '../api/client'
import { useToast } from '../context/ToastContext'
import { cn, fullDate, humanDate, isImage, kindOf } from '../lib/utils'
import { Icon, ICONS, IconButton, Spinner } from './ui'

/** 类型 → 笔绘风格的图标配色（描边 + 浅底）
 *
 *  配色只用参考站点 life.upxuu.com CSS 里出现的那几个颜色，
 *  保证与整站语言一致：主色 #38bdf8，辅助 #fde047 / #86efac / #93c5fd / #fca5a5。
 *  每种类型取一个色系，靠色相区分而不是靠图标花样，视觉上更整齐。 */
const KIND_STYLE: Record<string, { bg: string; border: string; fg: string; glyph: string }> = {
  // 文件夹 —— 参考站点的胶囊标签同款黄
  folder: { bg: '#fef9c3', border: '#fde047', fg: '#a16207', glyph: '📁' },
  // 图片 —— 主色蓝
  image: { bg: '#e0f2fe', border: '#7dd3fc', fg: '#0284c7', glyph: '🖼️' },
  // 视频 —— 柔和红
  video: { bg: '#fee2e2', border: '#fca5a5', fg: '#b91c1c', glyph: '🎬' },
  // 音频 —— 参考站点绿
  audio: { bg: '#dcfce7', border: '#86efac', fg: '#15803d', glyph: '🎵' },
  // 压缩包 —— 黄
  archive: { bg: '#fef3c7', border: '#fcd34d', fg: '#b45309', glyph: '🗜️' },
  // 文档 —— 参考站点浅蓝
  document: { bg: '#dbeafe', border: '#93c5fd', fg: '#1d4ed8', glyph: '📄' },
  // 代码 —— 主色蓝的深一档
  code: { bg: '#e0f2fe', border: '#38bdf8', fg: '#0369a1', glyph: '📜' },
  // 安装包 —— 绿
  apk: { bg: '#dcfce7', border: '#86efac', fg: '#3f6212', glyph: '📦' },
  // 字体 —— 柔紫（占比极低，用中性色即可）
  font: { bg: '#f3e8ff', border: '#d8b4fe', fg: '#7e22ce', glyph: '🔤' },
  // 其他 —— 中性灰
  // ⚠️ 字形选 🗂️ 而不是 📎：回形针在小尺寸下渲染极淡，
  //    截图里几乎看不见，用户分不清这类文件是什么。
  file: { bg: '#f1f5f9', border: '#cbd5e1', fg: '#475569', glyph: '🗂️' },
}

interface Props {
  entry: Entry
  selected: boolean
  selectMode: boolean
  /** 有上传任务进行中 —— 禁用删除，避免删除目标与上传目标产生竞态 */
  uploading?: boolean
  onToggleSelect(name: string): void
  onOpen(entry: Entry): void
  onPreview(entry: Entry): void
  onRename(entry: Entry): void
  onDelete(entry: Entry): void
}

export default function FileRow({
  entry,
  selected,
  selectMode,
  uploading = false,
  onToggleSelect,
  onOpen,
  onPreview,
  onRename,
  onDelete,
}: Props) {
  const toast = useToast()
  const style = KIND_STYLE[kindOf(entry.name, entry.is_dir)] ?? KIND_STYLE.file

  const [thumb, setThumb] = useState<string | null>(null)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // 图片缩略图：取 Blob 转 Object URL（凭证走请求头）
  useEffect(() => {
    if (!isImage(entry.name)) return

    let canceled = false
    const ac = new AbortController()

    api
      .fetchObjectUrl(entry.path, ac.signal)
      .then((url) => {
        if (canceled) {
          URL.revokeObjectURL(url)
          return
        }
        setThumb(url)
      })
      .catch(() => {
        if (!canceled) setThumbFailed(true)
      })

    return () => {
      canceled = true
      ac.abort()
      // 释放上一张，避免内存堆积
      setThumb((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [entry.path, entry.name])

  function handleClick() {
    if (selectMode) onToggleSelect(entry.name)
    else if (entry.is_dir) onOpen(entry)
    else onPreview(entry)
  }

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation()
    if (downloading) return
    setDownloading(true)
    const id = toast.info(`开始下载 ${entry.name}`, '准备中…')
    try {
      await api.download(entry.path, entry.name, (loaded, total) => {
        if (!total) return
        // 节流：只在百分比变化时才更新提示，避免刷屏
        const pct = Math.round((loaded / total) * 100)
        toast.dismiss(id)
        if (pct < 100) toast.info(`下载中 ${pct}%`, entry.name)
      })
      toast.success('下载完成', entry.name)
    } catch (err) {
      toast.error('下载失败', err instanceof ApiError ? err.friendly : '请重试')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors',
        selected
          ? 'bg-[--color-sky-100] ring-2 ring-[--color-sky-400]'
          : 'hover:bg-[--color-sky-50]',
      )}
    >
      {/* 复选框 + 类型图标 */}
      <div className="flex shrink-0 items-center gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(entry.name)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择 ${entry.name}`}
          className={cn(
            'size-4 cursor-pointer rounded border-slate-300 accent-[--color-sky-500] transition-opacity',
            selectMode || selected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        />

        <button
          type="button"
          onClick={handleClick}
          className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl text-lg"
          style={{ backgroundColor: style.bg, border: `2px solid ${style.border}` }}
          aria-label={entry.is_dir ? `进入 ${entry.name}` : `预览 ${entry.name}`}
        >
          {thumb && !thumbFailed ? (
            <img src={thumb} alt="" className="size-full object-cover" />
          ) : (
            <span aria-hidden>{style.glyph}</span>
          )}
        </button>
      </div>

      {/* 名称与元信息 */}
      <button
        type="button"
        onClick={handleClick}
        className="min-w-0 flex-1 text-left"
        aria-label={entry.is_dir ? `进入 ${entry.name}` : `预览 ${entry.name}`}
      >
        <p className="truncate-1 text-sm font-bold text-[--color-ink]">{entry.name}</p>
        <p className="mt-0.5 flex items-center gap-2 text-[11px] font-medium text-[--color-ink-faint]">
          <span className="truncate-1" title={fullDate(entry.mtime)}>
            {humanDate(entry.mtime)}
          </span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">
            {entry.is_dir ? '文件夹' : entry.size_h}
          </span>
        </p>
      </button>

      {/* 操作区 */}
      <div
        className={cn(
          'flex shrink-0 items-center gap-1 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        {!entry.is_dir && (
          <>
            <IconButton
              label="预览"
              onClick={(e) => {
                e.stopPropagation()
                onPreview(entry)
              }}
            >
              <Icon d={ICONS.eye} />
            </IconButton>

            <IconButton label="下载" onClick={handleDownload} disabled={downloading}>
              {downloading ? <Spinner className="size-3.5" /> : <Icon d={ICONS.download} />}
            </IconButton>
          </>
        )}

        <IconButton
          label="重命名"
          disabled={uploading}
          onClick={(e) => {
            e.stopPropagation()
            onRename(entry)
          }}
        >
          <Icon d={ICONS.rename} />
        </IconButton>

        <IconButton
          label="删除"
          tone="danger"
          disabled={uploading}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(entry)
          }}
        >
          <Icon d={ICONS.trash} />
        </IconButton>
      </div>
    </div>
  )
}
