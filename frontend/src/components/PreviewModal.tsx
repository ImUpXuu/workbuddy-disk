/**
 * 文件预览弹窗。
 *
 * 按类型分流：
 *   - 图片  → <img>
 *   - 视频  → <video controls>
 *   - 音频  → <audio controls>
 *   - 文本  → 按纯文本展示（限制大小，避免大文件卡死）
 *   - 其他  → 提示下载
 *
 * ⚠️ 所有资源都先经 fetch 取成 Blob，再转 Object URL。
 *    不能直接把带凭证的 URL 塞给 <img src> —— 线上网关会给查询参数
 *    追加 `:N` 后缀，破坏签名导致 401；且凭证会泄露到日志与历史。
 *    走 X-API-Key 请求头则完全没这些问题。
 */

import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../types/api'
import { api, ApiError } from '../api/client'
import { useToast } from '../context/ToastContext'
import { fullDate, humanSize, kindOf } from '../lib/utils'
import { Button, Icon, ICONS, Modal, ProgressBar, Spinner } from './ui'

/** 文本预览上限：超过只读前一段 */
const TEXT_PREVIEW_LIMIT = 256 * 1024

type LoadState = 'loading' | 'ready' | 'error'

export default function PreviewModal({
  entry,
  onClose,
}: {
  entry: Entry | null
  onClose(): void
}) {
  const toast = useToast()

  const [objectUrl, setObjectUrl] = useState('')
  const [state, setState] = useState<LoadState>('loading')
  const [errMsg, setErrMsg] = useState('')

  const [text, setText] = useState('')
  const [truncated, setTruncated] = useState(false)

  const [progress, setProgress] = useState(0)
  const [downloading, setDownloading] = useState(false)

  // 持有的 Object URL，卸载时统一释放
  const urlRef = useRef('')

  const kind = entry ? kindOf(entry.name, entry.is_dir) : 'file'
  const isText = !!entry && (kind === 'code' || (kind === 'document' && isPlainTextExt(entry.name)))
  const needBlob = !!entry && (kind === 'image' || kind === 'video' || kind === 'audio' || isText)

  // 拉取资源
  useEffect(() => {
    if (!entry) {
      setState('loading')
      setObjectUrl('')
      setText('')
      return
    }

    if (!needBlob) {
      setState('ready')
      return
    }

    let canceled = false
    const ac = new AbortController()
    setState('loading')
    setErrMsg('')

    api
      .fetchBlob(entry.path, undefined, ac.signal)
      .then(async (blob) => {
        if (canceled) return

        if (isText) {
          // 文本：只取前面一段，避免超大文件把页面卡住
          const slice = blob.slice(0, TEXT_PREVIEW_LIMIT)
          const content = await slice.text()
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
          <Button
            variant="primary"
            onClick={handleDownload}
            loading={downloading}
            icon={<Icon d={ICONS.download} />}
          >
            {downloading ? `下载中 ${Math.round(progress * 100)}%` : '下载'}
          </Button>
        </>
      }
    >
      {/* 元信息 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-[--color-ink-soft]">
        <span className="chip bg-[--color-sky-100] text-[--color-sky-700]">
          {humanSize(entry.size)}
        </span>
        <span>{fullDate(entry.mtime)}</span>
        <code className="truncate rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px]">
          {entry.path}
        </code>
      </div>

      {/* 下载进度条 */}
      {downloading && (
        <div className="mb-3">
          <ProgressBar value={progress} />
        </div>
      )}

      {/* 加载中 */}
      {state === 'loading' && (
        <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[--color-sky-200] py-14 text-sm font-bold text-[--color-ink-soft]">
          <Spinner />
          正在读取…
        </div>
      )}

      {/* 出错 */}
      {state === 'error' && (
        <div className="rounded-2xl border-2 border-red-200 bg-red-50 px-4 py-8 text-center">
          <p className="text-sm font-bold text-red-700">{errMsg || '读取失败'}</p>
          <p className="mt-1 text-xs text-red-500">可以直接下载到本地查看</p>
        </div>
      )}

      {/* ── 图片 ── */}
      {state === 'ready' && kind === 'image' && objectUrl && (
        <div className="grid place-items-center rounded-2xl border-2 border-[--color-sky-200] bg-white p-2">
          <img src={objectUrl} alt={entry.name} className="max-h-[55vh] w-auto rounded-xl object-contain" />
        </div>
      )}

      {/* ── 视频 ── */}
      {state === 'ready' && kind === 'video' && objectUrl && (
        <video
          src={objectUrl}
          controls
          preload="metadata"
          className="max-h-[55vh] w-full rounded-2xl border-2 border-[--color-sky-200] bg-black"
        >
          你的浏览器不支持视频播放。
        </video>
      )}

      {/* ── 音频 ── */}
      {state === 'ready' && kind === 'audio' && objectUrl && (
        <div className="rounded-2xl border-2 border-[--color-sky-200] bg-[--color-sky-50] p-5">
          <div className="mb-3 grid place-items-center text-4xl" aria-hidden>
            🎵
          </div>
          <audio src={objectUrl} controls preload="metadata" className="w-full">
            你的浏览器不支持音频播放。
          </audio>
        </div>
      )}

      {/* ── 文本 / 代码 ── */}
      {state === 'ready' && isText && (
        <>
          <pre className="max-h-[55vh] overflow-auto rounded-2xl border-2 border-slate-700 bg-slate-900 p-4 text-[12px] leading-relaxed text-slate-100">
            <code>{text}</code>
          </pre>
          {truncated && (
            <p className="mt-2 text-xs text-[--color-ink-faint]">
              内容较大，仅显示前 {humanSize(TEXT_PREVIEW_LIMIT)}。请下载完整文件查看。
            </p>
          )}
        </>
      )}

      {/* ── 不支持预览 ── */}
      {state === 'ready' && !needBlob && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[--color-sky-200] bg-[--color-sky-50] px-6 py-12 text-center">
          <span className="text-4xl" aria-hidden>
            📦
          </span>
          <p className="text-sm font-black text-[--color-ink]">这种格式不支持在线预览</p>
          <p className="text-xs text-[--color-ink-soft]">下载到本地即可查看</p>
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
