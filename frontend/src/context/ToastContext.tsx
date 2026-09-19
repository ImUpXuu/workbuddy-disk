/**
 * 全局提示（Toast）。
 *
 * 轻量实现，不引入第三方库。最多同时显示 4 条，自动消失，
 * 支持手动关闭。错误类提示停留更久，给用户读完的时间。
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { uid } from '../lib/utils'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
  /** 附加说明，可空 */
  detail?: string
}

interface ToastContextValue {
  toasts: Toast[]
  push(kind: ToastKind, message: string, detail?: string): string
  success(message: string, detail?: string): string
  error(message: string, detail?: string): string
  info(message: string, detail?: string): string
  warning(message: string, detail?: string): string
  dismiss(id: string): void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const MAX_TOASTS = 4
const DURATION: Record<ToastKind, number> = {
  success: 2600,
  info: 3000,
  warning: 4000,
  error: 5200,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string): string => {
      const id = uid()
      setToasts((list) => {
        const next = [...list, { id, kind, message, detail }]
        // 超出上限时挤掉最早的一条，并清掉它的定时器
        while (next.length > MAX_TOASTS) {
          const dropped = next.shift()
          if (dropped) {
            const t = timers.current.get(dropped.id)
            if (t) {
              clearTimeout(t)
              timers.current.delete(dropped.id)
            }
          }
        }
        return next
      })

      const timer = setTimeout(() => dismiss(id), DURATION[kind])
      timers.current.set(id, timer)
      return id
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      push,
      dismiss,
      success: (m, d) => push('success', m, d),
      error: (m, d) => push('error', m, d),
      info: (m, d) => push('info', m, d),
      warning: (m, d) => push('warning', m, d),
    }),
    [toasts, push, dismiss],
  )

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用')
  return ctx
}
