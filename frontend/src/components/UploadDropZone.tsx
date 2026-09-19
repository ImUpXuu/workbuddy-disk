/**
 * 拖拽上传投放区。
 *
 * 包在文件列表外层，整个区域都是投放目标。
 *
 * 三个必须处理好的细节（都是实际会踩的坑）：
 *
 * 1. **dragleave 计数**：dragenter/dragleave 会随子元素冒泡，
 *    鼠标划过列表里的任意一行都会触发一次 dragleave。用朴素布尔值
 *    会让遮罩不停闪烁。必须用计数器，归零才隐藏。
 *
 * 2. **dragover 必须 preventDefault**：否则浏览器默认行为是
 *    「用标签页打开这个文件」，`drop` 事件根本不会触发。
 *
 * 3. **遮罩必须 pointer-events-none**：否则拖拽事件落在遮罩上，
 *    计数会错乱，drop 也可能收不到。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { uploadEngine } from '../lib/uploadEngine'
import { collectFilesFromDataTransfer } from '../lib/fileCollect'
import { Icon, ICONS } from './ui'

interface Props {
  /**
   * 取「当前所在目录」。用 getter 而不是直接传值：
   * 拖拽事件处理器闭包会捕获渲染时的值，用户切目录后
   * 若还拿着旧值就会传错目录。getter 每次读到的都是最新的。
   */
  getTargetPath(): string
  children: ReactNode
}

/** 只对「真的拖了文件」的拖拽生效，避免拖选文字/链接时弹遮罩 */
function hasFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return Array.from(types).includes('Files')
}

export default function UploadDropZone({ getTargetPath, children }: Props) {
  const [dragging, setDragging] = useState(false)
  /** 进入/离开计数。用 ref 而非 state，避免与渲染竞争 */
  const depth = useRef(0)
  /** 拖进来的条目数，仅用于遮罩上的提示文案 */
  const [hint, setHint] = useState('')

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current++
    if (depth.current === 1) {
      setDragging(true)
      setHint(countHint(e))
    }
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    // 必须 preventDefault，否则 drop 不会触发
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      depth.current = 0
      setDragging(false)

      // ⚠️ 必须在这里**同步**取走 dataTransfer ——
      //    React 事件对象会被回收，异步之后再访问就是空的
      const dt = e.dataTransfer
      collectFilesFromDataTransfer(dt)
        .then((files) => {
          if (!files.length) return
          uploadEngine.addFiles(files, getTargetPath())
        })
        .catch(() => {
          /* 收集失败静默 —— 用户会从「没有反应」之外看到别的问题 */
        })
    },
    [getTargetPath],
  )

  // 兜底：拖到投放区之外松手时，阻止浏览器直接打开文件
  // （那会导致整个 SPA 状态丢失）
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}

      {dragging && (
        <div
          className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-[--radius-cute] border-2 border-dashed border-[--color-sky-400] bg-[--color-sky-50]/85 animate-[fade-in_120ms_ease-out]"
          aria-hidden
        >
          <div className="flex flex-col items-center gap-1.5 text-center">
            <span className="icon-disc size-14 text-2xl">
              <Icon d={ICONS.inbox} className="size-6 text-[--color-sky-600]" strokeWidth={2} />
            </span>
            <p className="text-base font-black text-[--color-sky-600]">松手即上传</p>
            <p className="text-xs font-bold text-[--color-ink-soft]">
              {hint} → 「{getTargetPath() || '根目录'}」
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/** 拖拽时能拿到的条目数提示（文件夹算 1 项，展开后可能更多） */
function countHint(e: React.DragEvent): string {
  const n = e.dataTransfer?.items?.length ?? 0
  return n > 0 ? `${n} 项` : '文件'
}
