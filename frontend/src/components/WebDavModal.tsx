/**
 * WebDAV 连接信息弹窗。
 *
 * 后端已实现 WebDAV 协议（挂载点 /dav/，HTTP Basic Auth），
 * 这里只负责把「地址 + 凭证怎么填」直观地展示给用户，并支持一键复制。
 */

import { useState } from 'react'
import { Button, Icon, ICONS, Modal } from './ui'

const CLIENTS: { name: string; steps: string }[] = [
  { name: 'Windows 资源管理器', steps: '地址栏输入地址 → 弹出登录框填用户名(任意)与密码 → 映射为网络驱动器' },
  { name: 'macOS Finder', steps: '菜单「前往 → 连接服务器」粘贴地址 → 选「注册用户」填密码' },
  { name: 'rclone', steps: 'type = webdav，url 填地址，vendor = other，user 任意，pass 填密码' },
  { name: 'Cyberduck / Mountain Duck', steps: '新建连接选 WebDAV，服务器填地址，登录名任意，密码填密钥' },
]

export default function WebDavModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const [copied, setCopied] = useState<string | null>(null)

  const url = `${window.location.origin}/dav/`

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 某些环境 clipboard 受限，退化为临时 textarea
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* 忽略 */ }
      document.body.removeChild(ta)
    }
    setCopied(label)
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
  }

  return (
    <Modal open={open} onClose={onClose} title="WebDAV 连接" size="md">
      <p className="text-[12.5px] leading-relaxed text-[--color-ink-soft]">
        本网盘已开启 WebDAV 协议，可在电脑 / 手机 / 服务器上像本地磁盘一样挂载使用。
        把下面的地址和凭证填进任意 WebDAV 客户端即可。
      </p>

      <div className="mt-3 space-y-2.5">
        <Field label="服务器地址" value={url} copied={copied === 'url'} onCopy={() => copy('url', url)} />
        <Field label="用户名" value="任意（如 admin）" copied={copied === 'user'} onCopy={() => copy('user', 'admin')} />
        <Field
          label="密码"
          value="登录密钥 或 任一 API Key"
          copied={copied === 'pass'}
          onCopy={() => copy('pass', '（见登录页「访问密钥」或「设置 → API Key」）')}
        />
      </div>

      <div className="mt-3 rounded border border-[--color-line] bg-[--color-surface-alt] px-3 py-2 text-[11.5px] leading-relaxed text-[--color-ink-soft]">
        <Icon d={ICONS.info} className="mr-1 inline size-3.5 align-[-2px] text-[--color-accent]" strokeWidth={2} />
        密码即你登录本网的「访问密钥」；也可在「分享管理」页用 API Key 登录（受危险操作开关约束）。
      </div>

      <div className="mt-3">
        <p className="win-nav-group-title mb-1.5">常见客户端</p>
        <ul className="space-y-1.5">
          {CLIENTS.map((c) => (
            <li key={c.name} className="text-[12px] leading-relaxed">
              <span className="font-semibold text-[--color-ink]">{c.name}</span>
              <span className="text-[--color-ink-soft]">：{c.steps}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={onClose} variant="primary" size="sm">知道了</Button>
      </div>
    </Modal>
  )
}

function Field({
  label, value, copied, onCopy,
}: { label: string; value: string; copied: boolean; onCopy(): void }) {
  return (
    <div>
      <div className="mb-1 text-[11.5px] font-medium text-[--color-ink-soft]">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate-1 rounded border border-[--color-line] bg-[--color-surface-alt] px-2.5 py-1.5 text-[12.5px] text-[--color-ink]">
          {value}
        </code>
        <Button
          size="sm"
          variant={copied ? 'primary' : 'ghost'}
          icon={<Icon d={copied ? ICONS.check : ICONS.copy} className="size-3.5" />}
          onClick={onCopy}
          aria-label={`复制${label}`}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
    </div>
  )
}
