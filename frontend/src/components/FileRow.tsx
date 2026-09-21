/**
 * 单个目录项（文件或文件夹）的行。
 *
 * 交互：
 *   - 单击 → 进入目录 / 预览文件
 *   - 桌面端：悬停显示操作按钮（预览、下载、重命名、删除）
 *   - 移动端：**长按**弹出底部操作抽屉（ActionSheet）
 *   - 勾选模式下显示复选框
 *
 * 缩略图与下载都走 Blob（fetch + X-API-Key 头），
 * 不把凭证放进 URL —— 那样会被网关改写，也会泄露到日志与浏览器历史。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Entry } from '../types/api'
import { api, ApiError } from '../api/client'
import { useToast } from '../context/ToastContext'
import { cn, fullDate, hasThumbnail, humanDate, isVideo, kindOf } from '../lib/utils'
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

// ═══════════════════════════════════════════════════════════════════
// 长按手势（移动端唤出操作菜单）
// ═══════════════════════════════════════════════════════════════════
//
// 这个手势是整个移动端体验里最容易做坏的地方，三个坑都踩过：
//
// 1. **onPointerDown 里绝不能 preventDefault()。**
//    看起来「阻止文本选择 / 阻止原生长按菜单」很合理，但副作用是
//    浏览器认定这个元素不参与滚动手势，列表**再也滚不动**了。
//    正确做法是让默认行为发生，改用「位移超过阈值就取消长按」来区分
//    「按住不动」和「滑动列表」。
//
// 2. **长按后浏览器会补发一次 click。**
//    手指抬起时 click 照常触发，会直接进入目录 / 打开预览 ——
//    用户明明只是想弹菜单。必须在 capture 阶段把这次 click 吞掉。
//
// 3. **只有触摸/手写笔才启用。**
//    桌面端鼠标按住 500ms 属于「拖选」，弹菜单会非常突兀。
//    用 pointerType === 'mouse' 直接跳过。
//
// 阈值取 500ms / 10px：低于 500ms 会和「点慢了的单击」混淆；
// 10px 是触摸抖动与真实滑动的经验分界。

const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE = 10

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
  /** 长按唤出操作菜单（仅移动端）。不传则长按无效果 */
  onLongPress?(entry: Entry): void
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
  onLongPress,
}: Props) {
  const toast = useToast()
  const style = KIND_STYLE[kindOf(entry.name, entry.is_dir)] ?? KIND_STYLE.file

  const [thumb, setThumb] = useState<string | null>(null)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // ── 长按 ────────────────────────────────────────────────────────
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  /** 本次长按是否已触发 —— 用来决定要不要吞掉随后补发的 click */
  const firedLongPress = useRef(false)

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressOrigin.current = null
  }, [])

  // 卸载时清掉未触发的定时器，避免对已卸载组件 setState
  useEffect(() => cancelPress, [cancelPress])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 桌面鼠标不参与 —— 按住是拖选行为，弹菜单很突兀
      if (e.pointerType === 'mouse') return
      if (!onLongPress) return
      // ⚠️ 这里**不能** preventDefault()，否则列表滚不动（见上方注释）
      if (e.button !== 0) return

      pressOrigin.current = { x: e.clientX, y: e.clientY }
      firedLongPress.current = false

      pressTimer.current = setTimeout(() => {
        pressTimer.current = null
        firedLongPress.current = true
        // 触发一点触觉反馈（支持的设备上）。放在 if 里避免旧浏览器报错
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate?.(15)
          } catch {
            /* 用户未授权 / 不支持 —— 不影响主流程 */
          }
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
      // 位移超阈值 = 用户在滑列表，取消长按，让滚动照常进行
      if (
        Math.abs(e.clientX - o.x) > LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(e.clientY - o.y) > LONG_PRESS_MOVE_TOLERANCE
      ) {
        cancelPress()
      }
    },
    [cancelPress],
  )

  /** capture 阶段拦截 click：长按已弹菜单时，把手指抬起补发的那次 click 吞掉 */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!firedLongPress.current) return
    firedLongPress.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // ── 缩略图：视口内才请求 ──────────────────────────────────────────
  //
  // 一个目录可能有几百张图，全部并发请求会把浏览器连接池打满，
  // 列表首次渲染也会被拖慢。用 IntersectionObserver 延迟到进入视口
  // 附近再取，配合 rootMargin 提前 200px 预加载，滚动时不会闪。
  const thumbBoxRef = useRef<HTMLButtonElement>(null)
  const [thumbVisible, setThumbVisible] = useState(false)
  const wantThumb = hasThumbnail(entry.name)

  useEffect(() => {
    if (!wantThumb) return
    const el = thumbBoxRef.current
    if (!el) return

    // 旧环境没有 IntersectionObserver：退化为立即加载
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

  // 图片与视频都走 /api/thumbnail（服务端生成、缓存、压缩）
  useEffect(() => {
    if (!wantThumb || !thumbVisible) return

    let canceled = false
    const ac = new AbortController()

    api
      .fetchThumbnailUrl(entry.path, ac.signal)
      .then((url) => {
        if (canceled) {
          URL.revokeObjectURL(url)
          return
        }
        setThumb(url)
      })
      .catch(() => {
        // 404 / 415 / 生成失败 —— 静默回退 emoji，不打扰用户
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
    // entry.mtime 变化（文件被覆盖）时需要重新取
  }, [wantThumb, thumbVisible, entry.path, entry.name, entry.mtime])

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
      // 稳定的测试锚点：端到端测试要在真实 DOM 上长按 / 派发触摸事件，
      // 靠 className 去猜行元素太脆。只用于定位，不参与运行时逻辑。
      data-file-row=""
      // ═══ 长按手势（仅移动端生效，见文件上方注释）═══
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      // 移动端长按会弹出系统「复制/搜索」菜单，屏蔽掉（这是原生行为，
      // 与我们的手势冲突；桌面端右键菜单也一并屏蔽，统一走操作按钮）
      onContextMenu={(e) => {
        if (onLongPress) e.preventDefault()
      }}
      // 吞掉长按后补发的 click
      onClickCapture={onClickCapture}
    >
      {/* 复选框 + 类型图标 */}
      <div className="flex shrink-0 items-center gap-2.5">
        {/* 复选框在移动端隐藏：长按已经能完成「选中/操作」的意图，
            再显示一个 4px 的勾选框只会让行更挤、误触更多。
            sm: 断点（640px）之上是桌面，保持原来的悬停显示。 */}
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(entry.name)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择 ${entry.name}`}
          className={cn(
            'hidden size-4 cursor-pointer rounded border-slate-300 accent-[--color-sky-500] transition-opacity sm:block',
            selectMode || selected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        />

        <button
          ref={thumbBoxRef}
          type="button"
          onClick={handleClick}
          className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl text-lg"
          style={{ backgroundColor: style.bg, border: `2px solid ${style.border}` }}
          aria-label={entry.is_dir ? `进入 ${entry.name}` : `预览 ${entry.name}`}
        >
          {thumb && !thumbFailed ? (
            <span className="relative size-full">
              <img src={thumb} alt="" className="size-full object-cover" />
              {/* 视频：叠一个播放角标，避免和普通图片混淆 */}
              {isVideo(entry.name) && (
                <span
                  className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-900/25 text-white"
                  aria-hidden
                >
                  <svg viewBox="0 0 24 24" className="size-4 drop-shadow" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              )}
            </span>
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

      {/* 操作区 —— 仅桌面端显示（移动端走长按出的 ActionSheet）。
          hidden sm:flex：小屏下整块不渲染可见内容，也不参与布局，
          行宽留给文件名。 */}
      <div
        className={cn(
          'hidden shrink-0 items-center gap-1 transition-opacity sm:flex',
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
