/**
 * Toast 渲染层。
 *
 * 固定在右上角，逐条堆叠。错误/警告带图标与更强对比，
 * 成功提示轻量一些，避免频繁上传时刷屏。
 */

import { useToast, type ToastKind } from '../context/ToastContext'
import { cn } from '../lib/utils'

const STYLE: Record<ToastKind, { wrap: string; icon: string }> = {
  success: {
    wrap: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    icon: '✓',
  },
  error: {
    wrap: 'border-red-300 bg-red-50 text-red-700',
    icon: '✕',
  },
  warning: {
    wrap: 'border-amber-300 bg-amber-50 text-amber-800',
    icon: '!',
  },
  info: {
    wrap: 'border-[--color-sky-400] bg-white text-[--color-sky-700]',
    icon: 'i',
  },
}

export default function ToastHost() {
  const { toasts, dismiss } = useToast()

  if (!toasts.length) return null

  return (
    <div
      className="pointer-events-none fixed top-4 right-4 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2.5"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const s = STYLE[t.kind]
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-2xl border-2 px-3.5 py-3',
              // 笔绘风：硬阴影
              'shadow-[3px_3px_0_currentColor]',
              'animate-[toast-in_180ms_ease-out]',
              s.wrap,
            )}
          >
            <span
              className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-current text-[10px] font-black"
              aria-hidden
            >
              {s.icon}
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug font-bold break-words">{t.message}</p>
              {t.detail && (
                <p className="mt-0.5 text-xs leading-snug font-medium opacity-75 break-words">
                  {t.detail}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-full p-1 opacity-50 transition-opacity hover:opacity-100"
              aria-label="关闭提示"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
