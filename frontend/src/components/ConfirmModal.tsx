/**
 * 确认弹窗：用于删除等不可逆操作。
 *
 * 危险操作给红色主按钮，并要求视觉上更明确的确认。
 */

import { type ReactNode } from 'react'
import { Button, Icon, ICONS, Modal } from './ui'

interface Props {
  open: boolean
  title: string
  message: ReactNode
  detail?: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
  onCancel(): void
  onConfirm(): void
}

export default function ConfirmModal({
  open,
  title,
  message,
  detail,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  busy,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        {danger && (
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded border border-[#e8b3ad] bg-[--color-danger-soft] text-[--color-danger]">
            <Icon d={ICONS.trash} className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-relaxed font-semibold break-words text-[--color-ink]">
            {message}
          </p>
          {detail && (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[--color-ink-soft]">{detail}</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
