/**
 * 通用输入弹窗：用于「重命名」与「新建文件夹」。
 *
 * 同一个组件服务两个场景，只是文案不同。
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal } from './ui'

interface Props {
  open: boolean
  title: string
  label: string
  initial?: string
  placeholder?: string
  confirmText?: string
  busy?: boolean
  onCancel(): void
  onConfirm(value: string): void
}

export default function PromptModal({
  open,
  title,
  label,
  initial = '',
  placeholder,
  confirmText = '确定',
  busy,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initial)
  const [err, setErr] = useState('')

  // 每次打开都用最新的初始值重置，避免残留上一次的输入
  useEffect(() => {
    if (open) {
      setValue(initial)
      setErr('')
    }
  }, [open, initial])

  function submit() {
    const v = value.trim()
    if (!v) {
      setErr('名称不能为空')
      return
    }
    if (/[/\\]/.test(v)) {
      setErr('名称不能包含 / 或 \\')
      return
    }
    if (v === initial) {
      onCancel() // 没改就直接关掉
      return
    }
    onConfirm(v)
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {confirmText}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Input
          label={label}
          value={value}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => {
            setValue(e.target.value)
            setErr('')
          }}
        />
        {err && <p className="mt-1.5 text-xs font-bold text-rose-600">{err}</p>}
        {/* 供回车提交，不可见 */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  )
}
