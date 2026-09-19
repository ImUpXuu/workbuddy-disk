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
    wrap: 'border-emerald-200 bg-emerald-50/95 text-emerald-900',
    icon: '✓',
  },
  error: {
    wrap: 'border-rose-200 bg-rose-50/95 text-rose-900',
    icon: '✕',
  },
  warning: {
    wrap: 'border-amber-200 bg-amber-50/95 text-amber-900',
    icon: '!',
  },
  info: {
    wrap: 'border-sky-200 bg-sky-50/95 text-sky-900',
    icon: 'i',
  },
}

export default function ToastHost() {
  const { toasts, dismiss } = useToast()

  if (!toasts.length) return null

  return (
    <div
      className="pointer-events-none fixed top-4 right-4 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const s = STYLE[t.kind]
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-2xl border px-3.5 py-3',
              'shadow-[0_8px_24px_-8px_rgb(15_23_42/0.18)] backdrop-blur-md',
              'animate-[toast-in_180ms_ease-out]',
              s.wrap,
            )}
          >
            <span
              className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-current/15 text-[10px] font-black"
              aria-hidden
            >
              {s.icon}
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug font-bold break-words">{t.message}</p>
              {t.detail && (
                <p className="mt-0.5 text-xs leading-snug opacity-75 break-words">{t.detail}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-full p-1 text-current/50 transition-colors hover:bg-current/10 hover:text-current"
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
