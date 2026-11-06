/**
 * 基础 UI 组件集合 —— Windows 文件资源管理器式。
 *
 * 视觉规范见 index.css。要点：
 *   - 扁平、1px 细边框、4~6px 小圆角，无硬阴影、无浮起动画
 *   - 按钮带文字标签，操作常驻，不靠 hover 才能发现
 *   - 弹窗是标准对话框（标题栏 + 内容 + 底部按钮区）
 *   - 保持导出接口不变，业务组件无需改调用方式
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
        size === 'sm' && '!min-h-[26px] !px-2 !py-1 !text-[11.5px]',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5" /> : icon}
      {children}
    </button>
  )
}

/** 命令栏按钮：图标 + 文字，无边框，hover 才显底色 */
export function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  danger,
  title,
  className,
}: {
  label?: string
  icon: ReactNode
  onClick?(e: React.MouseEvent): void
  disabled?: boolean
  active?: boolean
  danger?: boolean
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'win-tool',
        active && 'is-active',
        danger && 'is-danger',
        className,
      )}
    >
      {icon}
      {label && <span>{label}</span>}
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
        <label htmlFor={inputId} className="text-xs font-semibold text-[--color-ink-soft]">
          {label}
        </label>
      )}
      <input id={inputId} className={cn('field', className)} {...rest} />
      {hint && <p className="text-[11px] leading-snug text-[--color-ink-faint]">{hint}</p>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 开关：Windows 式方形滑轨
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
        <p className="text-[12.5px] font-semibold text-[--color-ink]">{label}</p>
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
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked
            ? danger
              ? 'border-amber-600 bg-amber-500'
              : 'border-[--color-accent] bg-[--color-accent]'
            : 'border-[--color-line-strong] bg-[#e6e9ed]',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-3.5 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-[2px]',
          )}
        />
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 模态框：标准对话框
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
        className="absolute inset-0 bg-slate-900/30 animate-[fade-in_120ms_ease-out]"
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
          'relative flex w-full flex-col bg-white focus:outline-none',
          'border border-[--color-line-strong] rounded-md shadow-[--shadow-cute-lg]',
          'animate-[modal-in_140ms_ease-out]',
          size === 'sm' && 'max-w-sm',
          size === 'md' && 'max-w-lg',
          size === 'lg' && 'max-w-3xl',
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[--color-line] px-4 py-3">
          <h2 className="truncate-1 text-[13px] font-semibold text-[--color-ink]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-6 shrink-0 place-items-center rounded text-[--color-ink-soft] transition-colors hover:bg-[#eceff3] hover:text-[--color-ink]"
            aria-label="关闭"
          >
            <Icon d={ICONS.close} className="size-3.5" strokeWidth={2} />
          </button>
        </header>

        <div className="max-h-[70vh] min-h-0 overflow-y-auto px-4 py-3.5">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[--color-line] bg-[--color-surface-alt] px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 上下文菜单（右键 / 更多按钮共用）
// ═══════════════════════════════════════════════════════════════════

export interface MenuItem {
  key: string
  label: string
  icon?: string
  kbd?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick(): void
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  // 贴边时翻转，避免菜单溢出视口
  const left = Math.min(x, Math.max(8, window.innerWidth - 196))
  const top = Math.min(y, Math.max(8, window.innerHeight - items.length * 34 - 20))

  return (
    <div ref={ref} className="win-menu animate-[fade-in_100ms_ease-out]" style={{ left, top }} role="menu">
      {items.map((item) =>
        item.separator ? (
          <div key={item.key} className="win-menu-sep" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-menu-item={item.key}
            onClick={() => {
              onClose()
              item.onClick()
            }}
            className={cn('win-menu-item', item.danger && 'is-danger')}
          >
            {item.icon && <Icon d={item.icon} className="size-3.5 shrink-0" strokeWidth={1.8} />}
            <span>{item.label}</span>
            {item.kbd && <span className="kbd">{item.kbd}</span>}
          </button>
        ),
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 底部抽屉（ActionSheet）—— 移动端操作菜单
// ═══════════════════════════════════════════════════════════════════
//
// z-index 分层：UploadPanel 60 < 抽屉 70 < Modal 80 < ContextMenu 90
// 抽屉低于 Modal，从抽屉点「删除」弹出的确认框才能盖在上面。

export interface SheetItem {
  key: string
  label: string
  icon: string
  danger?: boolean
  disabled?: boolean
  onClick(): void
}

interface ActionSheetProps {
  open: boolean
  onClose(): void
  title?: string
  subtitle?: string
  items: SheetItem[]
}

export function ActionSheet({ open, onClose, title, subtitle, items }: ActionSheetProps) {
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

  /** 先关抽屉再执行动作：两者的 body overflow 清理顺序不能颠倒 */
  function run(item: SheetItem) {
    if (item.disabled) return
    onClose()
    item.onClick()
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end sm:hidden">
      <div
        className="absolute inset-0 bg-slate-900/35 animate-[fade-in_120ms_ease-out]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || '文件操作'}
        tabIndex={-1}
        className="relative w-full bg-white focus:outline-none rounded-t-lg border-t border-[--color-line] pb-[max(0.75rem,env(safe-area-inset-bottom))] animate-[sheet-up_180ms_cubic-bezier(0.16,1,0.3,1)]"
      >
        <div className="flex justify-center pt-2.5" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-[--color-line-strong]" />
        </div>
        {(title || subtitle) && (
          <div className="px-5 pb-2.5 pt-3 text-center">
            <p className="truncate-1 text-[13px] font-semibold text-[--color-ink]">{title}</p>
            {subtitle && <p className="mt-0.5 text-[11px] text-[--color-ink-faint]">{subtitle}</p>}
          </div>
        )}
        <ul className="px-2 pb-1">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => run(item)}
                data-sheet-item={item.key}
                className={cn(
                  'flex w-full items-center gap-3 rounded px-4 py-3 text-left transition-colors disabled:opacity-40',
                  item.danger ? 'text-[--color-danger] active:bg-[--color-danger-soft]' : 'text-[--color-ink] active:bg-[#eef1f5]',
                )}
              >
                <Icon d={item.icon} className={cn('size-4', item.danger ? 'text-[--color-danger]' : 'text-[--color-ink-soft]')} />
                <span className="text-[12.5px] font-medium">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-[--color-line] px-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded px-4 py-3 text-center text-[12.5px] font-semibold text-[--color-ink-soft] active:bg-[#eef1f5]"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 空状态 / 骨架
// ═══════════════════════════════════════════════════════════════════

export function EmptyState({
  icon = 'file',
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
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="icon-disc size-12 text-[--color-ink-faint]" aria-hidden>
        <Icon d={icon} className="size-6" strokeWidth={1.5} />
      </div>
      <p className="text-[13px] font-semibold text-[--color-ink]">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-[--color-ink-soft]">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="p-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-[34px] items-center gap-3 border-b border-[#f0f2f4] px-2">
          <div className="skeleton size-3.5 shrink-0" />
          <div className="skeleton size-5 w-5 shrink-0" />
          <div className="skeleton h-3" style={{ width: `${28 + ((i * 11) % 40)}%` }} />
          <div className="skeleton ml-auto h-3 w-20" />
          <div className="skeleton h-3 w-14" />
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
    <div className={cn('h-1.5 w-full overflow-hidden rounded-sm bg-[#e6e9ed]', className)}>
      <div
        className={cn(
          'h-full transition-[width] duration-200 ease-out',
          tone === 'brand' && 'bg-[--color-accent]',
          tone === 'success' && 'bg-[--color-success]',
          tone === 'danger' && 'bg-[--color-danger]',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// 行内图标按钮（常驻，不靠 hover 出现）
// ═══════════════════════════════════════════════════════════════════

export function IconButton({
  label,
  onClick,
  children,
  tone = 'default',
  disabled,
  className,
}: {
  label: string
  onClick(e: React.MouseEvent): void
  children: ReactNode
  tone?: 'default' | 'danger'
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded border border-transparent bg-white transition-colors disabled:opacity-40',
        tone === 'default'
          ? 'text-[--color-ink-soft] hover:border-[--color-line] hover:bg-[#eef1f5] hover:text-[--color-ink]'
          : 'text-[--color-danger] hover:border-[#e8b3ad] hover:bg-[--color-danger-soft]',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** 表格行内的无边框小按钮 */
export function RowButton({
  label,
  onClick,
  children,
  danger,
  disabled,
}: {
  label: string
  onClick(e: React.MouseEvent): void
  children: ReactNode
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('win-row-btn', danger && 'is-danger')}
    >
      {children}
    </button>
  )
}

export function Icon({
  d,
  className,
  strokeWidth = 1.8,
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
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z',
  back: 'M19 12H5M12 19l-7-7 7-7',
  share: 'M18 8a3 3 0 1 0-2.8-4L8.9 7.6a3 3 0 1 0 0 4.8l6.3 3.6A3 3 0 1 0 18 16a3 3 0 0 0-2.4-2.9L9.3 9.5a3 3 0 0 0 0-1L15.6 4.9A3 3 0 0 0 18 8Z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  selectAll: 'M4 4h4v4H4zM14 4h6v16H4v-6M8 8l8 8',
  drive: 'M4 6h16v12H4zM8 10h8M8 14h5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  sort: 'M3 6h18M6 12h12M10 18h4',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  external: 'M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
} as const
