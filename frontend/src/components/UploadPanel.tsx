/**
 * 上传进度面板：右下角悬浮窗口（像浏览器下载浮层）。
 *
 * 悬浮而非 Modal：上传动辄几十秒，弹窗会挡住文件列表。
 * 视觉改为中性扁平窗口，与主界面一致。
 */

import { useEffect, useState } from 'react'
import { useUpload, useUploadActions } from '../hooks/useUpload'
import { useToast } from '../context/ToastContext'
import type { TaskView } from '../lib/uploadEngine'
import { cn, fileIconOf, fileIconTone, humanEta, humanSize, humanSpeed } from '../lib/utils'
import { Button, Icon, ICONS, IconButton, ProgressBar } from './ui'

export default function UploadPanel() {
  const snap = useUpload()
  const actions = useUploadActions()
  const toast = useToast()

  const [collapsed, setCollapsed] = useState(false)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    if (snap.activeCount > 0) { setCollapsed(false); setClosed(false) }
  }, [snap.activeCount])

  useEffect(() => actions.onWarning((msg) => toast.warning(msg)), [actions, toast])

  if (closed || snap.tasks.length === 0) return null

  const active = snap.activeCount > 0
  const failed = snap.failedCount
  const retryAllFailed = () => {
    snap.tasks.filter((t) => t.status === 'failed').forEach((t) => void actions.retry(t.id))
  }

  return (
    <div className="fixed right-4 bottom-4 z-[60] w-[min(24rem,calc(100vw-2rem))]">
      <div className="win-panel overflow-hidden shadow-[--shadow-cute-lg]">
        {/* 头部：点击折叠 */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-2 border-b border-[--color-line] bg-[--color-surface-alt] px-3 py-2 text-left hover:bg-[#eef1f5]"
        >
          <Icon d={ICONS.upload} className="size-4 shrink-0 text-[--color-accent]" />
          <span className="min-w-0 flex-1">
            <span className="truncate-1 block text-[12.5px] font-semibold text-[--color-ink]">
              {active ? `正在上传 ${snap.activeCount} 个文件`
                : failed > 0 ? `上传结束 · ${failed} 个失败`
                  : `已上传 ${snap.doneCount} 个文件`}
            </span>
            {active && (
              <span className="truncate-1 block text-[11px] tabular-nums text-[--color-ink-faint]">
                {humanSpeed(snap.totalSpeed)} · 剩余 {humanEta(snap.remainBytes, snap.totalSpeed)}
              </span>
            )}
          </span>
          <Icon d={collapsed ? ICONS.chevronUp : ICONS.chevronDown} className="size-4 shrink-0 text-[--color-ink-faint]" />
          <span
            role="button"
            tabIndex={0}
            aria-label="关闭面板"
            onClick={(e) => {
              e.stopPropagation()
              setClosed(true)
              if (active) toast.info('上传将在后台继续', '再次选择文件可重新打开面板')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setClosed(true) }
            }}
            className="grid size-6 shrink-0 place-items-center rounded text-[--color-ink-faint] hover:bg-white hover:text-[--color-ink]"
          >
            <Icon d={ICONS.close} className="size-3" />
          </span>
        </button>

        {collapsed ? (
          <ProgressBar value={snap.overallProgress} tone={overallTone(active, failed)} className="h-1 rounded-none" />
        ) : (
          <>
            <div className="px-3 pt-2.5 pb-2">
              <ProgressBar value={snap.overallProgress} tone={overallTone(active, failed)} />
              <p className="mt-1.5 text-[11px] tabular-nums text-[--color-ink-faint]">
                {snap.doneCount} / {snap.total} 完成
                {failed > 0 && ` · ${failed} 失败`}
                {snap.canceledCount > 0 && ` · ${snap.canceledCount} 已取消`}
              </p>
            </div>

            <ul className="max-h-64 overflow-y-auto px-1.5 pb-1.5">
              {snap.tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onCancel={() => void actions.cancel(t.id)}
                  onRetry={() => void actions.retry(t.id)}
                  onRemove={() => actions.remove(t.id)}
                />
              ))}
            </ul>

            <div className="flex items-center gap-2 border-t border-[--color-line] bg-[--color-surface-alt] px-3 py-2">
              {active ? (
                <Button size="sm" variant="danger" onClick={() => void actions.cancelAll()} icon={<Icon d={ICONS.close} className="size-3" />}>
                  全部取消
                </Button>
              ) : (
                <>
                  {failed > 0 && (
                    <Button size="sm" variant="primary" onClick={retryAllFailed} icon={<Icon d={ICONS.refresh} className="size-3" />}>
                      重试失败项
                    </Button>
                  )}
                  <Button size="sm" onClick={actions.clearFinished} className="ml-auto">清除记录</Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function overallTone(active: boolean, failed: number): 'brand' | 'success' | 'danger' {
  if (active) return 'brand'
  return failed > 0 ? 'danger' : 'success'
}

function TaskRow({ task, onCancel, onRetry, onRemove }: {
  task: TaskView
  onCancel(): void
  onRetry(): void
  onRemove(): void
}) {
  const running = task.status === 'queued' || task.status === 'uploading' || task.status === 'merging'
  return (
    <li className={cn(
      'flex items-start gap-2 rounded px-2 py-1.5',
      task.status === 'failed' && 'bg-[--color-danger-soft]',
      task.status === 'canceled' && 'opacity-55',
    )}>
      <span className="mt-0.5 shrink-0">
        <Icon d={fileIconOf(task.name, false)} className={cn('size-4', fileIconTone(task.name, false))} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate-1 text-[12px] font-medium text-[--color-ink]" title={task.name}>{task.name}</p>
          {task.status === 'merging' && (
            <span className="chip shrink-0 border border-[--color-line] bg-[--color-surface-alt] text-[--color-ink-soft]">合并中</span>
          )}
        </div>
        {task.status === 'failed' ? (
          <p className="mt-0.5 line-clamp-2 text-[10.5px] text-[--color-danger]">{task.error}</p>
        ) : task.status === 'canceled' ? (
          <p className="mt-0.5 text-[10.5px] text-[--color-ink-faint]">已取消</p>
        ) : (
          <>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] tabular-nums text-[--color-ink-faint]">
              {task.status === 'done' ? (
                <><Icon d={ICONS.check} className="size-3 text-[--color-success]" /><span>{humanSize(task.size)}</span></>
              ) : (
                <>
                  <span>{Math.round(task.progress * 100)}%</span>
                  <span aria-hidden>·</span>
                  <span>{humanSize(task.loaded)} / {humanSize(task.size)}</span>
                  {task.mode === 'chunked' && task.totalChunks > 1 && <><span aria-hidden>·</span><span>{task.doneChunks}/{task.totalChunks} 片</span></>}
                  {task.speed ? <><span aria-hidden>·</span><span>{humanSpeed(task.speed)}</span></> : null}
                </>
              )}
            </p>
            {task.status !== 'done' && <ProgressBar value={task.progress} className="mt-1 h-1" />}
          </>
        )}
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
        {running && <IconButton label="取消" tone="danger" onClick={onCancel} className="!size-6"><Icon d={ICONS.close} className="size-3" /></IconButton>}
        {(task.status === 'failed' || task.status === 'canceled') && (
          <>
            <IconButton label="重试" onClick={onRetry} className="!size-6"><Icon d={ICONS.refresh} className="size-3" /></IconButton>
            <IconButton label="移除" tone="danger" onClick={onRemove} className="!size-6"><Icon d={ICONS.trash} className="size-3" /></IconButton>
          </>
        )}
        {task.status === 'done' && <IconButton label="移除记录" onClick={onRemove} className="!size-6"><Icon d={ICONS.close} className="size-3" /></IconButton>}
      </div>
    </li>
  )
}
