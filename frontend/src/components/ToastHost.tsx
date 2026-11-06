/**
 * Toast 渲染层：右上角紧凑堆叠，细边框 + 轻阴影，无硬阴影装饰。
 */

import { useToast, type ToastKind } from '../context/ToastContext'
import { cn } from '../lib/utils'
import { Icon, ICONS } from './ui'

const STYLE: Record<ToastKind, { wrap: string; icon: string }> = {
  success: { wrap: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: ICONS.check },
  error: { wrap: 'border-[#e8b3ad] bg-[--color-danger-soft] text-[--color-danger]', icon: ICONS.close },
  warning: { wrap: 'border-amber-200 bg-amber-50 text-amber-800', icon: ICONS.info },
  info: { wrap: 'border-[--color-accent-line] bg-[--color-accent-soft] text-[--color-accent]', icon: ICONS.info },
}

export default function ToastHost() {
  const { toasts, dismiss } = useToast()
  if (!toasts.length) return null

  return (
    <div
      className="pointer-events-none fixed top-3 right-3 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const s = STYLE[t.kind]
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded border px-3 py-2.5 shadow-[--shadow-cute-lg]',
              'animate-[toast-in_140ms_ease-out]',
              s.wrap,
            )}
          >
            <Icon d={s.icon} className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] leading-snug font-semibold break-words">{t.message}</p>
              {t.detail && (
                <p className="mt-0.5 text-[11.5px] leading-snug font-normal opacity-80 break-words">{t.detail}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
              aria-label="关闭提示"
            >
              <Icon d={ICONS.close} className="size-3.5" strokeWidth={2.2} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
