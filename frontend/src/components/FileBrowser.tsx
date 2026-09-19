/**
 * 文件浏览器主体。
 *
 * 职责：
 *   - 目录导航（面包屑 + 返回上级）
 *   - 列表渲染、排序、搜索过滤
 *   - 多选与批量删除
 *   - 调用写操作（重命名 / 删除 / 新建文件夹）
 *
 * 目录状态不提升到 Context —— 只有这个页面用得到，
 * 放在局部 state 里更简单，也避免全局重渲染。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { Entry } from '../types/api'
import { useToast } from '../context/ToastContext'
import { buildBreadcrumb, cn, humanSize, parentPath, splitPath } from '../lib/utils'
import FileRow from './FileRow'
import PreviewModal from './PreviewModal'
import PromptModal from './PromptModal'
import ConfirmModal from './ConfirmModal'
import {
  Button,
  EmptyState,
  Icon,
  ICONS,
  SkeletonRows,
} from './ui'

type SortKey = 'name' | 'size' | 'mtime'

interface Props {
  /** 目录变化时通知外部（用于上传目标、统计等） */
  onPathChange?(path: string): void
  /** 供父组件触发上传文件选择 */
  onRequestUpload?(): void
  /** 上传任务是否进行中（用于禁用删除等） */
  uploading?: boolean
}

export default function FileBrowser({ onPathChange, onRequestUpload, uploading }: Props) {
  const toast = useToast()

  const [path, setPath] = useState('')
  const [items, setItems] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [asc, setAsc] = useState(true)

  // 弹窗状态
  const [preview, setPreview] = useState<Entry | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry[] | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState(0)

  // 请求竞态保护：目录快速切换时只认最后一次
  const reqSeq = useRef(0)

  const load = useCallback(
    async (target: string, silent = false) => {
      const seq = ++reqSeq.current
      if (!silent) setLoading(true)
      setError('')
      try {
        const res = await api.list(target)
        if (seq !== reqSeq.current) return // 已被更新的请求取代
        setItems(res.items || [])
        setPath(res.path ?? target)
        setSelected(new Set())
        setSelectMode(false)
      } catch (err) {
        if (seq !== reqSeq.current) return
        const msg = err instanceof ApiError ? err.friendly : '加载失败'
        setError(msg)
        setItems([])
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [],
  )

  // 首次加载
  useEffect(() => {
    void load('')
  }, [load])

  useEffect(() => {
    onPathChange?.(path)
  }, [path, onPathChange])

  // ── 派生数据：过滤 + 排序 ────────────────────────────────────
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = q ? items.filter((e) => e.name.toLowerCase().includes(q)) : items.slice()

    const dir = asc ? 1 : -1
    list.sort((a, b) => {
      // 目录永远在前，这是文件管理器的通行约定
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      switch (sort) {
        case 'size':
          return (a.size - b.size) * dir
        case 'mtime':
          return (a.mtime - b.mtime) * dir
        default:
          // 中文按本地排序规则，避免拼音乱序
          return a.name.localeCompare(b.name, 'zh-CN') * dir
      }
    })
    return list
  }, [items, query, sort, asc])

  const stats = useMemo(() => {
    const dirs = items.filter((e) => e.is_dir).length
    const files = items.length - dirs
    const total = items.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0)
    return { dirs, files, total }
  }, [items])

  const allChecked = visible.length > 0 && visible.every((e) => selected.has(e.name))

  // ── 交互 ────────────────────────────────────────────────────

  function openDir(entry: Entry) {
    void load(entry.path)
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(visible.map((e) => e.name)))
  }

  function goUp() {
    if (!path) return
    void load(parentPath(path))
  }

  async function doMkdir(name: string) {
    setBusy(true)
    try {
      await api.mkdir(path, name)
      toast.success('文件夹已创建', name)
      setMkdirOpen(false)
      await load(path, true)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.friendly : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function doRename(entry: Entry, newName: string) {
    setBusy(true)
    try {
      await api.rename(entry.path, newName)
      toast.success('已重命名', `${entry.name} → ${newName}`)
      setRenaming(null)
      await load(path, true)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.friendly : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  async function doDelete(entries: Entry[]) {
    setBusy(true)
    try {
      const res = await api.remove(entries.map((e) => e.path))
      const failedCount = res.failed?.length ?? 0
      const okCount = entries.length - failedCount

      if (failedCount === 0) {
        toast.success(`已删除 ${okCount} 项`)
      } else {
        toast.warning(`已删除 ${okCount} 项，${failedCount} 项失败`, res.failed?.[0]?.error)
      }
      setDeleting(null)
      await load(path, true)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.friendly : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 批量下载。
   *
   * 不引入 zip 库 —— 多文件时改为逐个触发浏览器下载，
   * 浏览器会自行排队。这样零依赖，且不占用内存做压缩。
   * 文件夹会被跳过并告知用户（递归打包需要额外实现）。
   */
  async function doDownloadSelected() {
    const files = selectedEntries.filter((e) => !e.is_dir)
    const dirCount = selectedEntries.length - files.length

    if (!files.length) {
      toast.warning('所选内容都是文件夹', '文件夹需进入后再选择其中的文件')
      return
    }

    setBatchBusy(true)
    let done = 0
    let failed = 0

    for (const f of files) {
      try {
        await api.download(f.path, f.name)
        done++
      } catch {
        failed++
      }
      setBatchProgress(Math.round(((done + failed) / files.length) * 100))
      // 连续触发下载时留一点间隔，避免浏览器把后续请求当弹窗拦截
      await new Promise((r) => setTimeout(r, 350))
    }

    setBatchBusy(false)
    setBatchProgress(0)

    if (failed === 0) {
      toast.success(`已下载 ${done} 个文件`, dirCount ? `跳过 ${dirCount} 个文件夹` : undefined)
    } else {
      toast.warning(`下载完成 ${done} 个，${failed} 个失败`, dirCount ? `跳过 ${dirCount} 个文件夹` : undefined)
    }
  }

  // 键盘快捷键：仅当没有弹窗时生效
  const anyModalOpen = !!(preview || renaming || deleting || mkdirOpen)
  useEffect(() => {
    if (anyModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      if (typing) return

      if (e.key === 'Backspace' && path) {
        e.preventDefault()
        goUp()
      }
      if (e.key === 'Delete' && selected.size) {
        e.preventDefault()
        setDeleting(items.filter((i) => selected.has(i.name)))
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectMode(true)
        setSelected(new Set(visible.map((i) => i.name)))
      }
      if (e.key === 'Escape') {
        setSelected(new Set())
        setSelectMode(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyModalOpen, path, selected, items, visible])

  const crumb = buildBreadcrumb(path)
  const selectedEntries = items.filter((i) => selected.has(i.name))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ═══ 工具栏 ═══ */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
        {/* 返回上级 */}
        <button
          type="button"
          onClick={goUp}
          disabled={!path}
          title="返回上级（Backspace）"
          aria-label="返回上级"
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-full border-2 bg-white transition-colors',
            path
              ? 'border-[--color-sky-400] text-[--color-sky-600] hover:bg-[--color-sky-50]'
              : 'cursor-not-allowed border-slate-200 text-slate-300',
          )}
        >
          <Icon d={ICONS.back} />
        </button>

        {/* 面包屑 */}
        <nav
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm"
          aria-label="目录路径"
        >
          <button
            type="button"
            onClick={() => void load('')}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border-2 px-2.5 py-1 font-bold transition-colors',
              path
                ? 'border-transparent text-[--color-ink-soft] hover:border-[--color-sky-200] hover:text-[--color-sky-600]'
                : 'border-[--color-sky-400] bg-[--color-sky-100] text-[--color-sky-700]',
            )}
          >
            <Icon d={ICONS.home} className="size-3.5" />
            根目录
          </button>

          {crumb.map((c, i) => (
            <span key={c.path} className="flex min-w-0 shrink-0 items-center gap-1">
              <span className="text-slate-300" aria-hidden>
                /
              </span>
              <button
                type="button"
                onClick={() => void load(c.path)}
                className={cn(
                  'truncate-1 max-w-[10rem] rounded-full border-2 px-2.5 py-1 font-bold transition-colors',
                  i === crumb.length - 1
                    ? 'border-[--color-sky-400] bg-[--color-sky-100] text-[--color-sky-700]'
                    : 'border-transparent text-[--color-ink-soft] hover:border-[--color-sky-200] hover:text-[--color-sky-600]',
                )}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>

        {/* 搜索 */}
        <div className="relative w-full sm:w-44">
          <Icon
            d={ICONS.search}
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[--color-ink-faint]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            className="field py-1.5 pr-7 pl-8 text-xs"
            aria-label="搜索当前目录"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[--color-ink-faint] hover:text-[--color-ink]"
              aria-label="清除搜索"
            >
              <Icon d={ICONS.close} className="size-3" />
            </button>
          )}
        </div>

        {/* 排序 */}
        <div className="flex items-center gap-1">
          {([
            ['name', '名称'],
            ['mtime', '时间'],
            ['size', '大小'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                if (sort === k) setAsc((v) => !v)
                else {
                  setSort(k)
                  setAsc(true)
                }
              }}
              className={cn(
                'flex items-center gap-0.5 rounded-full border-2 px-2.5 py-1 text-[11px] font-bold transition-colors',
                sort === k
                  ? 'border-[--color-sky-400] bg-[--color-sky-400] text-white'
                  : 'border-[--color-sky-200] bg-white text-[--color-sky-600] hover:border-[--color-sky-400]',
              )}
            >
              {label}
              {sort === k && (
                <span className="text-[9px]" aria-hidden>
                  {asc ? '▲' : '▼'}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* 操作按钮 */}
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            onClick={() => setMkdirOpen(true)}
            icon={<Icon d={ICONS.folderPlus} />}
            className="flex-1 sm:flex-none"
          >
            新建
          </Button>
          <Button
            variant="primary"
            onClick={onRequestUpload}
            icon={<Icon d={ICONS.upload} />}
            className="flex-1 sm:flex-none"
          >
            上传
          </Button>
        </div>
      </div>

      {/* ═══ 选中态工具条 ═══ */}
      <div className="flex min-h-9 flex-wrap items-center gap-2 px-3 pb-2 sm:px-4">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-[--color-ink-soft]">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            disabled={!visible.length}
            className="size-4 rounded border-slate-300 accent-[--color-sky-500]"
          />
          全选
        </label>

        {selected.size > 0 ? (
          <>
            <span className="chip border-2 border-[--color-sky-200] bg-[--color-sky-100] text-[--color-sky-700]">
              已选 {selected.size} 项
              {selectedEntries.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0) > 0 &&
                ` · ${humanSize(selectedEntries.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0))}`}
            </span>

            <button
              type="button"
              onClick={() => {
                setSelected(new Set())
                setSelectMode(false)
              }}
              className="text-xs font-bold text-[--color-ink-faint] hover:text-[--color-sky-600] hover:underline"
            >
              取消选择
            </button>

            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void doDownloadSelected()}
                disabled={batchBusy}
                icon={<Icon d={ICONS.download} className="size-3.5" />}
              >
                {batchBusy ? `打包中 ${batchProgress}%` : '下载所选'}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setDeleting(selectedEntries)}
                disabled={busy || uploading}
                icon={<Icon d={ICONS.trash} className="size-3.5" />}
              >
                删除
              </Button>
            </div>
          </>
        ) : (
          <span className="text-xs font-medium text-[--color-ink-faint]">
            {stats.dirs} 个文件夹 · {stats.files} 个文件
            {stats.total > 0 && ` · 共 ${humanSize(stats.total)}`}
            {query && ` · 匹配 ${visible.length} 项`}
          </span>
        )}
      </div>

      {/* ═══ 列表 ═══
          区块标题沿用参考站点规格：text-2xl font-black text-slate-800 + sky 色图标。 */}
      <h2 className="flex shrink-0 items-center gap-2 px-4 pt-1 pb-3 text-xl font-black text-slate-800 sm:text-2xl">
        <Icon
          d={path ? ICONS.folder : ICONS.cloud}
          className="size-5 shrink-0 text-[--color-sky-400] sm:size-6"
          strokeWidth={2.2}
        />
        {path ? (crumb[crumb.length - 1]?.name ?? '文件夹') : '根目录'}
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4 sm:px-2.5">
        {loading ? (
          <SkeletonRows rows={7} />
        ) : error ? (
          <EmptyState
            icon="⚠️"
            title="加载失败"
            hint={error}
            action={
              <Button onClick={() => void load(path)} icon={<Icon d={ICONS.refresh} />}>
                重试
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={query ? '🔍' : '📂'}
            title={query ? '没有匹配的内容' : '这个文件夹是空的'}
            hint={query ? `试试其他关键词，或清除「${query}」` : '拖拽文件到此处，或点击右上角「上传」'}
            action={
              query ? (
                <Button onClick={() => setQuery('')}>清除搜索</Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={onRequestUpload}
                  icon={<Icon d={ICONS.upload} />}
                >
                  上传文件
                </Button>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-1 px-2 pb-3">
            {visible.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={selected.has(entry.name)}
                selectMode={selectMode}
                onToggleSelect={toggleSelect}
                onOpen={openDir}
                onPreview={setPreview}
                onRename={setRenaming}
                onDelete={(e) => setDeleting([e])}
              />
            ))}
          </div>
        )}
      </div>

      {/* ═══ 弹窗 ═══ */}
      <PreviewModal entry={preview} onClose={() => setPreview(null)} />

      <PromptModal
        open={!!renaming}
        title="重命名"
        label="新名称"
        initial={renaming?.name ?? ''}
        confirmText="保存"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onConfirm={(v) => renaming && void doRename(renaming, v)}
      />

      <PromptModal
        open={mkdirOpen}
        title="新建文件夹"
        label="文件夹名称"
        placeholder="例如：备份"
        confirmText="创建"
        busy={busy}
        onCancel={() => setMkdirOpen(false)}
        onConfirm={(v) => void doMkdir(v)}
      />

      <ConfirmModal
        open={!!deleting}
        title="确认删除"
        danger
        busy={busy}
        message={
          deleting && deleting.length === 1
            ? `确定删除「${deleting[0].name}」吗？`
            : `确定删除选中的 ${deleting?.length ?? 0} 项吗？`
        }
        detail={
          deleting?.some((e) => e.is_dir)
            ? '包含文件夹，其中的所有内容会一并删除。'
            : '删除后无法恢复。'
        }
        confirmText="删除"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void doDelete(deleting)}
      />
    </div>
  )
}

/** 供父组件读取当前路径段（面包屑展示用） */
export function usePathSegments(path: string) {
  return useMemo(() => splitPath(path), [path])
}
