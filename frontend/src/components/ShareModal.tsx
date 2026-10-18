/**
 * 生成分享链接的弹窗。
 *
 * 用法：从文件操作（长按菜单 / 行内按钮）或工具栏「分享」唤起，
 * 传入要分享的文件或目录。选择有效期后点「生成链接」，即拿到一条
 * 可直接发给别人的公开链接（免登录即可访问）。
 */

import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ShareRecord } from '../types/api'
import { useToast } from '../context/ToastContext'
import { Button, Icon, ICONS } from './ui'

/** 可选有效期（天），0=永不过期 */
const EXPIRY_OPTIONS: { label: string; days: number }[] = [
  { label: '永久', days: 0 },
  { label: '1 天', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
]

interface Props {
  open: boolean
  onClose: () => void
  /** 要分享的文件 / 目录相对路径 */
  targetPath: string
  /** 展示名（文件名或目录名） */
  targetName: string
  isDir: boolean
  /** 生成后「在分享管理中查看」的回调（跳到管理页） */
  onManage?: () => void
}

export default function ShareModal({ open, onClose, targetPath, targetName, isDir, onManage }: Props) {
  const toast = useToast()
  const [expiresDays, setExpiresDays] = useState(0)
  const [result, setResult] = useState<ShareRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  // 每次打开重置状态
  useEffect(() => {
    if (open) {
      setResult(null)
      setExpiresDays(0)
      setCopied(false)
    }
  }, [open])

  if (!open) return null

  async function generate() {
    setBusy(true)
    setCopied(false)
    try {
      const res = await api.createShare(targetPath, expiresDays)
      setResult(res.item)
      const abs = absoluteLink(res.item.url)
      try {
        await navigator.clipboard.writeText(abs)
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
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-3 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="cute-border w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-1 flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-full bg-[--color-sky-100] text-[--color-sky-600]">
            <Icon d={ICONS.share} className="size-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-black text-slate-800">创建分享链接</h3>
            <p className="truncate-1 text-xs font-bold text-[--color-ink-soft]">
              {isDir ? '目录' : '文件'} · {targetName}
            </p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <Icon d={ICONS.close} className="size-4" />
          </button>
        </div>

        {!result ? (
          <>
            <p className="mb-3 mt-3 text-xs font-medium text-[--color-ink-faint]">
              任何人拿到链接都可直接访问，无需登录。
            </p>
            <div className="mb-4 flex flex-wrap gap-2">
              {EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setExpiresDays(opt.days)}
                  className={
                    'rounded-full border-2 px-3 py-1 text-xs font-bold transition-colors ' +
                    (expiresDays === opt.days
                      ? 'border-[--color-sky-400] bg-[--color-sky-400] text-white'
                      : 'border-[--color-sky-200] bg-white text-[--color-sky-600] hover:border-[--color-sky-400]')
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" onClick={generate} disabled={busy}>
                {busy ? '生成中…' : '生成链接'}
              </Button>
              <Button onClick={onClose} disabled={busy}>
                取消
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 mt-3 text-xs font-bold text-[--color-ink-soft]">公开链接</p>
            <div className="flex items-center gap-2 rounded-xl border-2 border-slate-200 bg-slate-50 p-2">
              <input
                readOnly
                value={absoluteLink(result.url)}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent px-1 text-xs text-slate-700 outline-none"
              />
              <Button size="sm" onClick={copy} icon={<Icon d={copied ? ICONS.check : ICONS.copy} className="size-3.5" />}>
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <p className="mt-2 text-xs font-medium text-[--color-ink-faint]">
              {result.is_dir ? '目录分享' : '文件分享'} · 有效期 {result.expires_h}
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" className="flex-1" onClick={onManage}>
                在分享管理中查看
              </Button>
              <Button onClick={onClose}>完成</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 后端给的是相对 hash 链接，补成当前站点绝对地址，方便直接发给别人。 */
function absoluteLink(url: string): string {
  if (/^https?:\/\//.test(url)) return url
  return `${window.location.origin}${url}`
}
