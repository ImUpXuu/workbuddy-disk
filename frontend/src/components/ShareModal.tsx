/**
 * 生成分享链接的弹窗（标准对话框）。
 * 选择有效期 → 生成 → 自动复制，链接可直接发给别人。
 */

import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ShareRecord } from '../types/api'
import { useToast } from '../context/ToastContext'
import { Button, Icon, ICONS, Modal } from './ui'
import { cn } from '../lib/utils'

/** 可选有效期（天），0=永不过期 */
const EXPIRY_OPTIONS: { label: string; days: number }[] = [
  { label: '永久', days: 0 },
  { label: '1 天', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
]

interface Props {
  open: boolean
  onClose(): void
  targetPath: string
  targetName: string
  isDir: boolean
  onManage?: () => void
}

export default function ShareModal({ open, onClose, targetPath, targetName, isDir, onManage }: Props) {
  const toast = useToast()
  const [expiresDays, setExpiresDays] = useState(0)
  const [result, setResult] = useState<ShareRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) { setResult(null); setExpiresDays(0); setCopied(false) }
  }, [open])

  if (!open) return null

  async function generate() {
    setBusy(true)
    setCopied(false)
    try {
      const res = await api.createShare(targetPath, expiresDays)
      setResult(res.item)
      try {
        await navigator.clipboard.writeText(absoluteLink(res.item.url))
        setCopied(true)
        toast.success('链接已生成并复制到剪贴板')
      } catch {
        toast.success('链接已生成（请手动复制）')
      }
    } catch (err) {
      toast.error('生成失败', err instanceof Error ? err.message : '请重试')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(absoluteLink(result.url))
      setCopied(true)
      toast.success('链接已复制')
    } catch {
      toast.warning('复制失败', '请手动选择链接文本复制')
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="创建分享链接"
      size="md"
      footer={result ? (
        <>
          <Button onClick={onClose}>完成</Button>
          {onManage && <Button variant="primary" onClick={onManage}>在分享管理中查看</Button>}
        </>
      ) : (
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={generate} loading={busy} icon={<Icon d={ICONS.link} className="size-3.5" />}>
            {busy ? '生成中…' : '生成链接'}
          </Button>
        </>
      )}
    >
      {/* 目标 */}
      <div className="mb-4 flex items-center gap-2.5 border border-[--color-line] bg-[--color-surface-alt] px-3 py-2.5">
        <Icon d={isDir ? ICONS.folder : ICONS.file} className={cn('size-4 shrink-0', isDir ? 'text-amber-600' : 'text-[--color-ink-faint]')} />
        <div className="min-w-0">
          <p className="truncate-1 text-[12.5px] font-semibold text-[--color-ink]">{targetName}</p>
          <p className="truncate-1 text-[11px] text-[--color-ink-faint]">{isDir ? '目录分享' : '文件分享'} · {targetPath || '根目录'}</p>
        </div>
      </div>

      {!result ? (
        <>
          <p className="mb-2 text-[12px] font-semibold text-[--color-ink-soft]">有效期</p>
          <div className="flex flex-wrap gap-2">
            {EXPIRY_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setExpiresDays(opt.days)}
                className={cn(
                  'rounded border px-3 py-1.5 text-[12px] transition-colors',
                  expiresDays === opt.days
                    ? 'border-[--color-accent] bg-[--color-accent-soft] font-semibold text-[--color-accent]'
                    : 'border-[--color-line-strong] bg-white text-[--color-ink-soft] hover:bg-[#f0f2f5]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-[--color-ink-soft]">
            任何拿到链接的人都能直接访问，无需登录。链接即凭证，请只发给需要的人。
          </p>
        </>
      ) : (
        <>
          <p className="mb-2 text-[12px] font-semibold text-[--color-ink-soft]">公开链接</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={absoluteLink(result.url)}
              onFocus={(e) => e.currentTarget.select()}
              className="field min-w-0 flex-1 font-mono text-[11.5px]"
              aria-label="公开链接"
            />
            <Button onClick={() => void copy()} icon={<Icon d={copied ? ICONS.check : ICONS.copy} className="size-3.5" />}>
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          <p className="mt-2 text-[11.5px] text-[--color-ink-faint]">
            {result.is_dir ? '目录分享' : '文件分享'} · 有效期 {result.expires_h}
          </p>
        </>
      )}
    </Modal>
  )
}

/** 后端给的是相对 hash 链接，补成当前站点绝对地址 */
function absoluteLink(url: string): string {
  if (/^https?:\/\//.test(url)) return url
  return `${window.location.origin}${url}`
}
