/**
 * 基础 UI 组件集合。
 *
 * 视觉规范见 index.css 的「笔绘风格组件」区块。
 * 统一风格的关键：所有可交互元素都带 2px 描边 + 硬阴影，
 * 悬停浮起、按下压平。
 */

import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { cn } from '../lib/utils'

// ═══════════════════════════════════════════════════════════════════
// 加载指示
// ═══════════════════════════════════════════════════════════════════

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4 animate-spin', className)} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 按钮
// ═══════════════════════════════════════════════════════════════════

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  loading?: boolean
  icon?: ReactNode
  size?: 'sm' | 'md'
}

export function Button({
  variant = 'ghost',
  loading = false,
  icon,
  size = 'md',
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && '!px-3 !py-1.5 !text-xs',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 输入框
// ═══════════════════════════════════════════════════════════════════

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
}

export function Input({ label, hint, className, id, ...rest }: InputProps) {
  const inputId = id || rest.name
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-xs font-bold text-[--color-sky-600]">
          {label}
        </label>
      )}
      <input id={inputId} className={cn('field', className)} {...rest} />
      {hint && <p className="text-[11px] leading-snug text-[--color-ink-faint]">{hint}</p>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 开关：描边 + 硬阴影风格
// ═══════════════════════════════════════════════════════════════════

interface SwitchProps {
  checked: boolean
  onChange(next: boolean): void
  label: string
  hint?: string
  disabled?: boolean
  danger?: boolean
}

export function Switch({ checked, onChange, label, hint, disabled, danger }: SwitchProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-bold text-[--color-ink]">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-snug text-[--color-ink-soft]">{hint}</p>}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-7 w-12 shrink-0 rounded-full border-2 transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked
            ? danger
              ? 'border-amber-400 bg-amber-400'
              : 'border-[--color-sky-400] bg-[--color-sky-400]'
            : 'border-slate-300 bg-slate-200',
        )}
      >
        <span
          className={cn(
            'absolute top-[1px] size-5 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[1.375rem]' : 'translate-x-[1px]',
          )}
        />
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 模态框：笔绘卡片
// ═══════════════════════════════════════════════════════════════════

interface ModalProps {
  open: boolean
  onClose(): void
  title: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/25 animate-[fade-in_140ms_ease-out]"
        onClick={onClose}
        aria-hidden
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative w-full bg-white focus:outline-none',
          // 笔绘卡片：2px 描边 + 硬阴影 + 大圆角
          'border-2 border-[--color-sky-400] rounded-3xl',
          'shadow-[6px_6px_0_var(--color-sky-400)]',
          'animate-[modal-in_180ms_ease-out]',
          size === 'sm' && 'max-w-sm',
          size === 'md' && 'max-w-lg',
          size === 'lg' && 'max-w-2xl',
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b-2 border-[--color-sky-100] px-5 py-4">
          <h2 className="text-base font-black text-[--color-ink]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full border-2 border-[--color-sky-200] bg-white text-[--color-ink-soft] transition-colors hover:border-[--color-sky-400] hover:text-[--color-sky-600]"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t-2 border-[--color-sky-100] px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 空状态 / 骨架
// ═══════════════════════════════════════════════════════════════════

export function EmptyState({
  icon = '🗂️',
  title,
  hint,
  action,
}: {
  icon?: string
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="icon-disc size-14 text-2xl" aria-hidden>
        {icon}
      </span>
      <p className="text-sm font-black text-[--color-ink]">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-[--color-ink-soft]">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <div className="skeleton size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3" style={{ width: `${45 + ((i * 13) % 35)}%` }} />
            <div className="skeleton h-2.5 w-24" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 进度条
// ═══════════════════════════════════════════════════════════════════

export function ProgressBar({
  value,
  className,
  tone = 'brand',
}: {
  value: number
  className?: string
  tone?: 'brand' | 'success' | 'danger'
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-slate-200', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-200 ease-out',
          tone === 'brand' && 'bg-[--color-sky-400]',
          tone === 'success' && 'bg-emerald-400',
          tone === 'danger' && 'bg-rose-400',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 图标按钮：圆形描边，悬停浮起
// ═══════════════════════════════════════════════════════════════════

export function IconButton({
  label,
  onClick,
  children,
  tone = 'default',
  disabled,
}: {
  label: string
  onClick(e: React.MouseEvent): void
  children: ReactNode
  tone?: 'default' | 'danger'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-8 place-items-center rounded-full border-2 bg-white transition-colors disabled:opacity-40',
        tone === 'default'
          ? 'border-[--color-sky-200] text-[--color-sky-600] hover:border-[--color-sky-400] hover:bg-[--color-sky-50]'
          : 'border-red-200 text-red-500 hover:border-red-400 hover:bg-red-50',
      )}
    >
      {children}
    </button>
  )
}

export function Icon({
  d,
  className,
  strokeWidth = 2,
}: {
  d: string
  className?: string
  strokeWidth?: number
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-4', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  )
}

// 常用图标路径，集中管理避免各处硬编码
export const ICONS = {
  folderPlus: 'M12 5v14M5 12h14',
  upload: 'M12 19V5M5 12l7-7 7 7',
  download: 'M12 5v14M19 12l-7 7-7-7',
  rename: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  refresh: 'M21 2v6h-6M3 22v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L21 8M21 15a9 9 0 0 1-14.9 3.4L3 16',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M9.9 4.24A9.1 9.1 0 0 1 12 4c6.4 0 10 7 10 7a17.7 17.7 0 0 1-2.16 3.19M6.61 6.61A17.6 17.6 0 0 0 2 11s3.6 7 10 7a9 9 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20',
  copy: 'M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2ZM5 15H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1',
  plus: 'M12 5v14M5 12h14',
  key: 'M15 7a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM11.5 12.5 2 22M6 18l2 2M9 15l2 2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  cloud: 'M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.3 9.5 4.5 4.5 0 0 0 6.5 19Z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM21 15l-5-5L5 21',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  chevronRight: 'M9 18l6-6-6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z',
  back: 'M19 12H5M12 19l-7-7 7-7',
} as const
