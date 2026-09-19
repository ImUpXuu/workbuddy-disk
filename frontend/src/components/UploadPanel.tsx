/**
 * 上传进度面板：右下角悬浮卡片。
 *
 * 为什么要悬浮而不是 Modal：上传动辄几十秒到几分钟，弹窗会挡住文件列表，
 * 用户既不能继续浏览，关掉后又看不到进度。悬浮卡片可以边看边操作。
 *
 * 传重大小与全站一致（笔绘风：2px 描边 + 硬阴影 + 大圆角）。
 */

import { useEffect, useState } from 'react'
import { useUpload, useUploadActions } from '../hooks/useUpload'
import { useToast } from '../context/ToastContext'
import type { TaskView } from '../lib/uploadEngine'
import { cn, humanEta, humanSize, humanSpeed, iconOf, kindOf } from '../lib/utils'
import { Button, Icon, ICONS, IconButton, ProgressBar } from './ui'

/** 文件类型 → 笔绘配色，与 FileRow 的 KIND_STYLE 保持同一套色板 */
const KIND_TINT: Record<string, string> = {
  folder: '#fde047',
  image: '#7dd3fc',
  video: '#fca5a5',
  audio: '#86efac',
  archive: '#fcd34d',
  document: '#93c5fd',
  code: '#38bdf8',
  apk: '#86efac',
  font: '#d8b4fe',
  file: '#cbd5e1',
}

export default function UploadPanel() {
  const snap = useUpload()
  const actions = useUploadActions()
  const toast = useToast()

  const [collapsed, setCollapsed] = useState(false)
  const [closed, setClosed] = useState(false)

  // 有新任务进来就自动展开 —— 用户点了上传就该看到反馈，
  // 哪怕之前手动折叠/关闭过
  useEffect(() => {
    if (snap.activeCount > 0) {
      setCollapsed(false)
      setClosed(false)
    }
  }, [snap.activeCount])

  // 引擎的非致命警告（例如后端拒绝清理临时分片）转成 toast
  useEffect(() => actions.onWarning((msg) => toast.warning(msg)), [actions, toast])

  // 无任务时完全不渲染，不占屏幕
  if (closed || snap.tasks.length === 0) return null

  const active = snap.activeCount > 0
  const failed = snap.failedCount

  const retryAllFailed = () => {
    snap.tasks.filter((t) => t.status === 'failed').forEach((t) => void actions.retry(t.id))
  }

  return (
    <div className="fixed right-4 bottom-4 z-[60] w-[min(22rem,calc(100vw-2rem))]">
      <div className="cute-border overflow-hidden">
        {/* ═══ 头部（点击折叠）═══ */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-2 border-b-2 border-[--color-sky-100] bg-[--color-sky-50] px-3.5 py-2.5 text-left"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full border-2 border-[--color-sky-200] bg-white text-[--color-sky-600]">
            <Icon d={ICONS.upload} className="size-3.5" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="truncate-1 block text-xs font-black text-[--color-ink]">
              {active
                ? `正在上传 ${snap.activeCount} 个文件`
                : failed > 0
                  ? `上传结束 · ${failed} 个失败`
                  : `已上传 ${snap.doneCount} 个文件`}
            </span>
            {active && (
              <span className="truncate-1 block text-[10px] font-bold text-[--color-ink-faint] tabular-nums">
                {humanSpeed(snap.totalSpeed)} · 剩余{' '}
                {humanEta(snap.remainBytes, snap.totalSpeed)}
              </span>
            )}
          </span>

          <Icon
            d={collapsed ? ICONS.chevronUp : ICONS.chevronDown}
            className="size-4 shrink-0 text-[--color-ink-faint]"
          />

          <span
            role="button"
            tabIndex={0}
            aria-label="关闭面板"
            onClick={(e) => {
              e.stopPropagation()
              setClosed(true)
              // 上传不会因此中断 —— 说清楚，免得用户以为关掉就取消了
              if (active) {
                toast.info('上传将在后台继续', '再次选择文件可重新打开面板')
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setClosed(true)
              }
            }}
            className="grid size-6 shrink-0 place-items-center rounded-full text-[--color-ink-faint] hover:bg-white hover:text-[--color-ink]"
          >
            <Icon d={ICONS.close} className="size-3" />
          </span>
        </button>

        {/* ═══ 折叠态：只留一条细进度条 ═══ */}
        {collapsed ? (
          <ProgressBar
            value={snap.overallProgress}
            tone={overallTone(active, failed)}
            className="h-1.5 rounded-none"
          />
        ) : (
          <>
            {/* ═══ 总进度 ═══ */}
            <div className="px-3.5 pt-3 pb-2">
              <ProgressBar value={snap.overallProgress} tone={overallTone(active, failed)} />
              <p className="mt-1.5 text-[10px] font-bold text-[--color-ink-faint] tabular-nums">
                {snap.doneCount} / {snap.total} 完成
                {failed > 0 && ` · ${failed} 失败`}
                {snap.canceledCount > 0 && ` · ${snap.canceledCount} 已取消`}
              </p>
            </div>

            {/* ═══ 任务列表 ═══ */}
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

            {/* ═══ 底部操作 ═══ */}
            <div className="flex items-center gap-2 border-t-2 border-[--color-sky-100] px-3 py-2.5">
              {active ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void actions.cancelAll()}
                  icon={<Icon d={ICONS.close} className="size-3.5" />}
                >
                  全部取消
                </Button>
              ) : (
                <>
                  {failed > 0 && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={retryAllFailed}
                      icon={<Icon d={ICONS.refresh} className="size-3.5" />}
                    >
                      重试失败项
                    </Button>
                  )}
                  <Button size="sm" onClick={actions.clearFinished} className="ml-auto">
                    清除记录
                  </Button>
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

// ═══════════════════════════════════════════════════════════════════
// 单个任务行
// ═══════════════════════════════════════════════════════════════════

function TaskRow({
  task,
  onCancel,
  onRetry,
  onRemove,
}: {
  task: TaskView
  onCancel(): void
  onRetry(): void
  onRemove(): void
}) {
  const tint = KIND_TINT[kindOf(task.name, false)] ?? KIND_TINT.file
  const running = task.status === 'queued' || task.status === 'uploading' || task.status === 'merging'

  return (
    <li
      className={cn(
        'flex items-start gap-2.5 rounded-2xl px-2.5 py-2',
        task.status === 'failed' && 'bg-red-50',
        task.status === 'canceled' && 'opacity-55',
      )}
    >
      {/* 类型图标 */}
      <span
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-sm"
        style={{ backgroundColor: `${tint}33`, border: `2px solid ${tint}` }}
        aria-hidden
      >
        {iconOf(task.name, false)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate-1 text-xs font-bold text-[--color-ink]" title={task.name}>
            {task.name}
          </p>
          {task.status === 'merging' && (
            <span className="chip shrink-0 border-2 border-[--color-sky-200] bg-[--color-sky-100] text-[--color-sky-700]">
              合并中
            </span>
          )}
        </div>

        {/* 失败：显示原因 */}
        {task.status === 'failed' ? (
          <p className="mt-0.5 line-clamp-2 text-[10px] font-bold text-red-600">{task.error}</p>
        ) : task.status === 'canceled' ? (
          <p className="mt-0.5 text-[10px] font-bold text-[--color-ink-faint]">已取消</p>
        ) : (
          <>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] font-bold text-[--color-ink-faint] tabular-nums">
              {task.status === 'done' ? (
                <>
                  <Icon d={ICONS.check} className="size-3 text-emerald-500" />
                  <span>{humanSize(task.size)}</span>
                </>
              ) : (
                <>
                  <span>{Math.round(task.progress * 100)}%</span>
                  <span aria-hidden>·</span>
                  <span>
                    {humanSize(task.loaded)} / {humanSize(task.size)}
                  </span>
                  {task.mode === 'chunked' && task.totalChunks > 1 && (
                    <>
                      <span aria-hidden>·</span>
                      <span>
                        {task.doneChunks}/{task.totalChunks} 片
                      </span>
                    </>
                  )}
                  {task.speed ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>{humanSpeed(task.speed)}</span>
                    </>
                  ) : null}
                </>
              )}
            </p>
            {task.status !== 'done' && (
              <ProgressBar
                value={task.progress}
                className="mt-1 h-1.5"
              />
            )}
          </>
        )}
      </div>

      {/* 操作 */}
      <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
        {running && (
          <IconButton label="取消" tone="danger" onClick={onCancel}>
            <Icon d={ICONS.close} className="size-3.5" />
          </IconButton>
        )}
        {(task.status === 'failed' || task.status === 'canceled') && (
          <>
            <IconButton label="重试" onClick={onRetry}>
              <Icon d={ICONS.refresh} className="size-3.5" />
            </IconButton>
            <IconButton label="移除" tone="danger" onClick={onRemove}>
              <Icon d={ICONS.trash} className="size-3.5" />
            </IconButton>
          </>
        )}
        {task.status === 'done' && (
          <IconButton label="移除记录" onClick={onRemove}>
            <Icon d={ICONS.close} className="size-3.5" />
          </IconButton>
        )}
      </div>
    </li>
  )
}
