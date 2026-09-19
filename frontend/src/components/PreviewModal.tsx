/**
 * 文件预览弹窗。
 *
 * 按类型分流：
 *   - 图片  → <img>
 *   - 视频  → <video controls>
 *   - 音频  → <audio controls>
 *   - 文本  → fetch 前若干字节，按纯文本展示（避免大文件卡死）
 *   - 其他  → 提示下载
 *
 * 所有资源都通过 api.downloadUrl 构造，凭证已拼进查询参数，
 * 所以 <img src> 这种原生标签也能正常鉴权。
 */

import { useEffect, useState } from 'react'
import type { Entry } from '../types/api'
import { api } from '../api/client'
import { fullDate, humanSize, kindOf } from '../lib/utils'
import { Button, Icon, ICONS, Modal, Spinner } from './ui'

/** 文本预览的上限：超过就只读前面一段，避免浏览器被大文件拖死 */
const TEXT_PREVIEW_LIMIT = 256 * 1024

export default function PreviewModal({
  entry,
  onClose,
}: {
  entry: Entry | null
  onClose(): void
}) {
  const [text, setText] = useState('')
  const [textState, setTextState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [truncated, setTruncated] = useState(false)

  const kind = entry ? kindOf(entry.name, entry.is_dir) : 'file'
  const url = entry ? api.downloadUrl(entry.path) : ''

  // 文本类才去拉内容
  useEffect(() => {
    if (!entry) {
      setText('')
      setTextState('idle')
      setTruncated(false)
      return
    }

    const isText = kind === 'code' || (kind === 'document' && isPlainTextExt(entry.name))
    if (!isText) return

    let canceled = false
    setTextState('loading')
    setText('')

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((t) => {
        if (canceled) return
        if (t.length > TEXT_PREVIEW_LIMIT) {
          setText(t.slice(0, TEXT_PREVIEW_LIMIT))
          setTruncated(true)
        } else {
          setText(t)
        }
        setTextState('done')
      })
      .catch(() => {
        if (!canceled) setTextState('error')
      })

    return () => {
      canceled = true
    }
  }, [entry, url, kind])

  if (!entry) return null

  return (
    <Modal
      open
      onClose={onClose}
      title={entry.name}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <a href={url} download={entry.name} className="btn btn-primary">
            <Icon d={ICONS.download} />
            下载
          </a>
        </>
      }
    >
      {/* 元信息 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[--color-ink-soft]">
        <span className="font-bold">{humanSize(entry.size)}</span>
        <span className="text-slate-300" aria-hidden>
          ·
        </span>
        <span>{fullDate(entry.mtime)}</span>
        <span className="text-slate-300" aria-hidden>
          ·
        </span>
        <code className="truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">
          {entry.path}
        </code>
      </div>

      {/* ── 图片 ── */}
      {kind === 'image' && (
        <div className="grid place-items-center rounded-2xl bg-slate-50 p-2">
          <img
            src={url}
            alt={entry.name}
            className="max-h-[55vh] w-auto rounded-xl object-contain"
          />
        </div>
      )}

      {/* ── 视频 ── */}
      {kind === 'video' && (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-[55vh] w-full rounded-2xl bg-black"
        >
          你的浏览器不支持视频播放。
        </video>
      )}

      {/* ── 音频 ── */}
      {kind === 'audio' && (
        <div className="rounded-2xl bg-gradient-to-br from-[--color-brand-50] to-white p-5">
          <div className="mb-3 grid place-items-center text-4xl" aria-hidden>
            🎵
          </div>
          <audio src={url} controls preload="metadata" className="w-full">
            你的浏览器不支持音频播放。
          </audio>
        </div>
      )}

      {/* ── 文本 / 代码 ── */}
      {(kind === 'code' || (kind === 'document' && isPlainTextExt(entry.name))) && (
        <>
          {textState === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-[--color-ink-soft]">
              <Spinner />
              正在读取…
            </div>
          )}
          {textState === 'error' && (
            <div className="rounded-xl bg-rose-50 px-4 py-6 text-center text-sm text-rose-700">
              读取失败，可能是编码不受支持。请下载后查看。
            </div>
          )}
          {textState === 'done' && (
            <>
              <pre className="max-h-[55vh] overflow-auto rounded-2xl bg-slate-900 p-4 text-[12px] leading-relaxed text-slate-100">
                <code>{text}</code>
              </pre>
              {truncated && (
                <p className="mt-2 text-xs text-[--color-ink-faint]">
                  内容较大，仅显示前 {humanSize(TEXT_PREVIEW_LIMIT)}。请下载完整文件查看。
                </p>
              )}
            </>
          )}
        </>
      )}

      {/* ── 其他：不支持预览 ── */}
      {kind !== 'image' &&
        kind !== 'video' &&
        kind !== 'audio' &&
        kind !== 'code' &&
        !(kind === 'document' && isPlainTextExt(entry.name)) && (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-50 px-6 py-12 text-center">
            <span className="text-4xl opacity-60" aria-hidden>
              📦
            </span>
            <p className="text-sm font-bold text-[--color-ink-soft]">
              这种格式不支持在线预览
            </p>
            <p className="text-xs text-[--color-ink-faint]">下载到本地即可查看</p>
          </div>
        )}
    </Modal>
  )
}

/** 纯文本类扩展名（能被 <pre> 直接显示，不依赖渲染器） */
function isPlainTextExt(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i < 0) return false
  const ext = name.slice(i + 1).toLowerCase()
  return [
    'txt', 'md', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'log',
    'csv', 'tsv', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'sh',
    'bash', 'zsh', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'sql',
    'gitignore', 'env', 'editorconfig',
  ].includes(ext)
}
