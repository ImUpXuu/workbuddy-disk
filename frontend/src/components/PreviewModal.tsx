/**
 * 文件预览弹窗（标准对话框）。
 *
 * 按类型分流：图片 <img> / 视频 <video> / 音频 <audio> / 文本 <pre> / 其他提示下载。
 *
 * ⚠️ 所有资源先经 fetch 取成 Blob 再转 Object URL，不能直接把带凭证的 URL
 *    塞给 <img src> —— 网关会改写查询参数破坏签名，凭证也会泄露到日志。
 */

import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../types/api'
import { api, ApiError } from '../api/client'
import { useToast } from '../context/ToastContext'
import { fullDate, humanSize, kindLabel, kindOf } from '../lib/utils'
import { Button, Icon, ICONS, Modal, ProgressBar, Spinner } from './ui'

const TEXT_PREVIEW_LIMIT = 256 * 1024

type LoadState = 'loading' | 'ready' | 'error'

export default function PreviewModal({ entry, onClose }: { entry: Entry | null; onClose(): void }) {
  const toast = useToast()
  const [objectUrl, setObjectUrl] = useState('')
  const [state, setState] = useState<LoadState>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [text, setText] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [progress, setProgress] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const urlRef = useRef('')

  const kind = entry ? kindOf(entry.name, entry.is_dir) : 'file'
  const isText = !!entry && (kind === 'code' || (kind === 'document' && isPlainTextExt(entry.name)))
  const needBlob = !!entry && (kind === 'image' || kind === 'video' || kind === 'audio' || isText)

  useEffect(() => {
    if (!entry) {
      setState('loading'); setObjectUrl(''); setText('')
      return
    }
    if (!needBlob) { setState('ready'); return }

    let canceled = false
    const ac = new AbortController()
    setState('loading')
    setErrMsg('')

    api.fetchBlob(entry.path, undefined, ac.signal)
      .then(async (blob) => {
        if (canceled) return
        if (isText) {
          const content = await blob.slice(0, TEXT_PREVIEW_LIMIT).text()
          if (canceled) return
          setText(content)
          setTruncated(blob.size > TEXT_PREVIEW_LIMIT)
        } else {
          const url = URL.createObjectURL(blob)
          urlRef.current = url
          setObjectUrl(url)
        }
        setState('ready')
      })
      .catch((err) => {
        if (canceled) return
        setErrMsg(err instanceof ApiError ? err.friendly : '读取失败')
        setState('error')
      })

    return () => {
      canceled = true
      ac.abort()
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = ''
      }
    }
  }, [entry, needBlob, isText])

  async function handleDownload() {
    if (!entry || downloading) return
    setDownloading(true)
    setProgress(0)
    try {
      await api.download(entry.path, entry.name, (loaded, total) => {
        if (total) setProgress(loaded / total)
      })
      toast.success('下载完成', entry.name)
    } catch (err) {
      toast.error('下载失败', err instanceof ApiError ? err.friendly : '请重试')
    } finally {
      setDownloading(false)
      setProgress(0)
    }
  }

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
          <Button variant="primary" onClick={handleDownload} loading={downloading} icon={<Icon d={ICONS.download} className="size-3.5" />}>
            {downloading ? `下载中 ${Math.round(progress * 100)}%` : '下载'}
          </Button>
        </>
      }
    >
      {/* 元信息 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[--color-ink-soft]">
        <span className="chip border border-[--color-line] bg-[--color-surface-alt]">{kindLabel(entry.name, false)}</span>
        <span>{humanSize(entry.size)}</span>
        <span>{fullDate(entry.mtime)}</span>
        <code className="truncate rounded bg-[#f2f4f7] px-1.5 py-0.5 font-mono text-[11px]">{entry.path}</code>
      </div>

      {downloading && <div className="mb-3"><ProgressBar value={progress} /></div>}

      {state === 'loading' && (
        <div className="flex items-center justify-center gap-2 border border-dashed border-[--color-line] py-14 text-[12.5px] text-[--color-ink-soft]">
          <Spinner className="size-4" /> 正在读取…
        </div>
      )}

      {state === 'error' && (
        <div className="border border-[#e8b3ad] bg-[--color-danger-soft] px-4 py-8 text-center">
          <p className="text-[12.5px] font-semibold text-[--color-danger]">{errMsg || '读取失败'}</p>
          <p className="mt-1 text-[11.5px] text-[--color-ink-soft]">可以直接下载到本地查看</p>
        </div>
      )}

      {state === 'ready' && kind === 'image' && objectUrl && (
        <div className="grid place-items-center rounded border border-[--color-line] bg-[#f7f8fa] p-2">
          <img src={objectUrl} alt={entry.name} className="max-h-[55vh] w-auto object-contain" />
        </div>
      )}

      {state === 'ready' && kind === 'video' && objectUrl && (
        <video src={objectUrl} controls preload="metadata" className="max-h-[55vh] w-full rounded bg-black">
          你的浏览器不支持视频播放。
        </video>
      )}

      {state === 'ready' && kind === 'audio' && objectUrl && (
        <div className="rounded border border-[--color-line] bg-[--color-surface-alt] p-5">
          <div className="mb-3 flex justify-center text-[--color-ink-faint]">
            <Icon d={ICONS.info} className="size-8" strokeWidth={1.2} />
          </div>
          <audio src={objectUrl} controls preload="metadata" className="w-full">你的浏览器不支持音频播放。</audio>
        </div>
      )}

      {state === 'ready' && isText && (
        <>
          <pre className="max-h-[55vh] overflow-auto rounded border border-slate-700 bg-slate-900 p-4 text-[12px] leading-relaxed text-slate-100">
            <code>{text}</code>
          </pre>
          {truncated && <p className="mt-2 text-[11.5px] text-[--color-ink-faint]">内容较大，仅显示前 {humanSize(TEXT_PREVIEW_LIMIT)}。请下载完整文件查看。</p>}
        </>
      )}

      {state === 'ready' && !needBlob && (
        <div className="flex flex-col items-center gap-2 border border-dashed border-[--color-line] bg-[--color-surface-alt] px-6 py-12 text-center">
          <Icon d={ICONS.file} className="size-9 text-[--color-ink-faint]" strokeWidth={1.2} />
          <p className="text-[12.5px] font-semibold text-[--color-ink]">这种格式不支持在线预览</p>
          <p className="text-[11.5px] text-[--color-ink-soft]">下载到本地即可查看</p>
        </div>
      )}
    </Modal>
  )
}

/** 纯文本类扩展名（能被 <pre> 直接显示） */
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
