/**
 * 单个目录项的表格行（Windows 资源管理器式详细信息视图）。
 *
 * 列：复选框 | 名称 | 修改日期 | 类型 | 大小 | 操作
 *   - 复选框与操作按钮**常驻**，不依赖 hover / 右键，触屏也能直接点
 *   - 单击名称 → 进入目录 / 预览文件；Ctrl / Shift + 单击 → 范围多选
 *   - 右键 → 交给父组件打开上下文菜单（桌面增强，不是唯一入口）
 *   - 移动端长按 → ActionSheet（保留既有手势，与常驻按钮并存）
 *
 * 缩略图仍走 Blob + IntersectionObserver 懒加载，凭证不进 URL。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Entry } from '../types/api'
import { api, ApiError } from '../api/client'
import { useToast } from '../context/ToastContext'
import {
  cn, fileIconOf, fileIconTone, fullDate, hasThumbnail, humanDate,
  isVideo, kindLabel,
} from '../lib/utils'
import { Icon, ICONS, RowButton, Spinner } from './ui'

const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE = 10

interface Props {
  entry: Entry
  selected: boolean
  uploading?: boolean
  /** 点击复选框 */
  onToggleSelect(name: string): void
  /** 带修饰键的行点击（Ctrl / Shift 多选由父组件处理） */
  onRowClick(entry: Entry, e: React.MouseEvent): void
  /** 单击名称 / 图标：进入目录或预览文件 */
  onActivate(entry: Entry): void
  onPreview(entry: Entry): void
  onRename(entry: Entry): void
  onDelete(entry: Entry): void
  onShare(entry: Entry): void
  /** 右键打开上下文菜单 */
  onContextMenu?(entry: Entry, x: number, y: number): void
  /** 移动端长按唤出操作抽屉 */
  onLongPress?(entry: Entry): void
}

export default function FileRow({
  entry,
  selected,
  uploading = false,
  onToggleSelect,
  onRowClick,
  onActivate,
  onPreview,
  onRename,
  onDelete,
  onShare,
  onContextMenu,
  onLongPress,
}: Props) {
  const toast = useToast()
  const kindIcon = fileIconOf(entry.name, entry.is_dir)
  const kindTone = fileIconTone(entry.name, entry.is_dir)

  const [thumb, setThumb] = useState<string | null>(null)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // ── 长按手势（移动端）──────────────────────────────────────────
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const firedLongPress = useRef(false)

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressOrigin.current = null
  }, [])

  useEffect(() => cancelPress, [cancelPress])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' || !onLongPress || e.button !== 0) return
      // 不能 preventDefault()，否则列表滚不动
      pressOrigin.current = { x: e.clientX, y: e.clientY }
      firedLongPress.current = false
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null
        firedLongPress.current = true
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try { navigator.vibrate?.(15) } catch { /* 不支持不影响主流程 */ }
        }
        onLongPress(entry)
      }, LONG_PRESS_MS)
    },
    [entry, onLongPress],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const o = pressOrigin.current
      if (!o || pressTimer.current === null) return
      if (
        Math.abs(e.clientX - o.x) > LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(e.clientY - o.y) > LONG_PRESS_MOVE_TOLERANCE
      ) cancelPress()
    },
    [cancelPress],
  )

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!firedLongPress.current) return
    firedLongPress.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // ── 缩略图：视口内才请求 ────────────────────────────────────────
  const thumbBoxRef = useRef<HTMLButtonElement>(null)
  const [thumbVisible, setThumbVisible] = useState(false)
  const wantThumb = hasThumbnail(entry.name)

  useEffect(() => {
    if (!wantThumb) return
    const el = thumbBoxRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setThumbVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setThumbVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [wantThumb, entry.path])

  useEffect(() => {
    if (!wantThumb || !thumbVisible) return
    let canceled = false
    const ac = new AbortController()
    api.fetchThumbnailUrl(entry.path, ac.signal)
      .then((url) => {
        if (canceled) { URL.revokeObjectURL(url); return }
        setThumb(url)
      })
      .catch(() => { if (!canceled) setThumbFailed(true) })
    return () => {
      canceled = true
      ac.abort()
      setThumb((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [wantThumb, thumbVisible, entry.path, entry.name, entry.mtime])

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation()
    if (downloading) return
    setDownloading(true)
    const id = toast.info(`开始下载 ${entry.name}`, '准备中…')
    try {
      await api.download(entry.path, entry.name, (loaded, total) => {
        if (!total) return
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
      className={cn('win-row', selected && 'is-selected')}
      data-file-row=""
      onClick={(e) => onRowClick(entry, e)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(entry, e.clientX, e.clientY)
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onClickCapture={onClickCapture}
    >
      {/* ① 复选框：常驻 */}
      <div className="flex items-center justify-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(entry.name)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择 ${entry.name}`}
        />
      </div>

      {/* ② 名称：图标 + 文件名 */}
      <div className="win-td is-name flex min-w-0 items-center gap-2">
        <button
          ref={thumbBoxRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); onActivate(entry) }}
          className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-sm bg-[#f2f4f7]"
          aria-label={entry.is_dir ? `进入 ${entry.name}` : `预览 ${entry.name}`}
        >
          {thumb && !thumbFailed ? (
            <span className="relative size-full">
              <img src={thumb} alt="" className="size-full object-cover" />
              {isVideo(entry.name) && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-900/30 text-white" aria-hidden>
                  <svg viewBox="0 0 24 24" className="size-3" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </span>
              )}
            </span>
          ) : (
            <Icon d={kindIcon} className={cn('size-3.5', kindTone)} strokeWidth={1.8} />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onActivate(entry) }}
          className="min-w-0 truncate-1 text-left text-[12.5px] text-[--color-ink] hover:underline"
          title={entry.name}
        >
          {entry.name}
        </button>
      </div>

      {/* ③ 修改日期 */}
      <div className="win-td win-hide-md" title={fullDate(entry.mtime)}>{humanDate(entry.mtime)}</div>

      {/* ④ 类型 */}
      <div className="win-td win-hide-md" title={kindLabel(entry.name, entry.is_dir)}>
        {kindLabel(entry.name, entry.is_dir)}
      </div>

      {/* ⑤ 大小 */}
      <div className="win-td win-hide-sm is-num">{entry.is_dir ? '' : entry.size_h}</div>

      {/* ⑥ 操作：常驻按钮，两端一致 */}
      <div className="win-td is-actions">
        {!entry.is_dir && (
          <RowButton
            label="预览"
            onClick={(e) => { e.stopPropagation(); onPreview(entry) }}
          >
            <Icon d={ICONS.eye} className="size-3.5" />
          </RowButton>
        )}
        {!entry.is_dir && (
          <RowButton label="下载" onClick={handleDownload} disabled={downloading}>
            {downloading ? <Spinner className="size-3" /> : <Icon d={ICONS.download} className="size-3.5" />}
          </RowButton>
        )}
        <RowButton label="分享" onClick={(e) => { e.stopPropagation(); onShare(entry) }}>
          <Icon d={ICONS.share} className="size-3.5" />
        </RowButton>
        <RowButton label="重命名" disabled={uploading} onClick={(e) => { e.stopPropagation(); onRename(entry) }}>
          <Icon d={ICONS.rename} className="size-3.5" />
        </RowButton>
        <RowButton label="删除" danger disabled={uploading} onClick={(e) => { e.stopPropagation(); onDelete(entry) }}>
          <Icon d={ICONS.trash} className="size-3.5" />
        </RowButton>
      </div>
    </div>
  )
}
