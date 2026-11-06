/**
 * 文件浏览器主体 —— Windows 文件资源管理器式「详细信息」视图。
 *
 * 结构自上而下：
 *   命令栏   常驻操作（新建 / 上传 / 刷新 / 全选 / 下载 / 删除 / 分享 / 搜索）
 *   地址栏   后退 / 前进 / 上一级 / 刷新 + 可编辑路径（点击空白处切输入）
 *   列表     点列头排序（名称 / 修改日期 / 类型 / 大小）
 *   状态栏   项目数 / 选中数 / 总大小 / 当前路径
 *
 * 交互约定（两端一致，不依赖悬停 / 右键才能找到功能）：
 *   - 单击名称 → 进入目录 / 预览文件；点复选框或行空白 → 选中
 *   - Ctrl + 单击 → 切换单项；Shift + 单击 → 范围选择；Ctrl+A → 全选
 *   - 右键 → 上下文菜单（桌面增强，所有操作在命令栏/行内按钮里也有）
 *   - 移动端长按 → 底部抽屉
 *   - 快捷键：Backspace 上级、Delete 删除、F2 重命名、Esc 清空选择
 *
 * 目录状态不提升到 Context —— 只有这个页面用得到。
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle,
  useMemo, useRef, useState,
} from 'react'
import { api, ApiError } from '../api/client'
import type { Entry } from '../types/api'
import { useToast } from '../context/ToastContext'
import {
  buildBreadcrumb, cn, humanSize, kindLabel, parentPath, splitPath,
} from '../lib/utils'
import { parseHash, syncDiskPath } from '../lib/router'
import FileRow from './FileRow'
import PreviewModal from './PreviewModal'
import PromptModal from './PromptModal'
import ConfirmModal from './ConfirmModal'
import ShareModal from './ShareModal'
import {
  ActionSheet, Button, ContextMenu, EmptyState, Icon, ICONS,
  SkeletonRows, ToolButton, type MenuItem, type SheetItem,
} from './ui'

type SortKey = 'name' | 'mtime' | 'type' | 'size'

interface Props {
  onPathChange?(path: string): void
  onRequestUpload?(): void
  uploading?: boolean
}

export interface FileBrowserHandle {
  reload(): void
  currentPath(): string
}

/** 供父组件读取当前路径段（面包屑展示用） */
export function usePathSegments(path: string) {
  return useMemo(() => splitPath(path), [path])
}

const FileBrowser = forwardRef<FileBrowserHandle, Props>(function FileBrowser(
  { onPathChange, onRequestUpload, uploading },
  ref,
) {
  const toast = useToast()

  const [path, setPath] = useState('')
  const [items, setItems] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [asc, setAsc] = useState(true)
  const [pathEditing, setPathEditing] = useState(false)
  const [pathDraft, setPathDraft] = useState('')

  // 弹窗状态
  const [preview, setPreview] = useState<Entry | null>(null)
  const [renaming, setRenaming] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry[] | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [sheetFor, setSheetFor] = useState<Entry | null>(null)
  const [shareFor, setShareFor] = useState<Entry | null>(null)
  /** 右键 / 更多菜单：{x, y, entry|null}。entry 为 null 表示空白处右键 */
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState(0)

  const reqSeq = useRef(0)
  /** 多选锚点：Shift 范围选择的起点（在 visible 里的下标） */
  const anchorRef = useRef<number | null>(null)

  const load = useCallback(async (target: string, silent = false) => {
    const seq = ++reqSeq.current
    if (!silent) setLoading(true)
    setError('')
    try {
      const res = await api.list(target)
      if (seq !== reqSeq.current) return
      setItems(res.items || [])
      setPath(res.path ?? target)
      setSelected(new Set())
      anchorRef.current = null
      syncDiskPath(res.path ?? target)
    } catch (err) {
      if (seq !== reqSeq.current) return
      setError(err instanceof ApiError ? err.friendly : '加载失败')
      setItems([])
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  const pathRef = useRef(path)
  useEffect(() => { pathRef.current = path }, [path])

  useImperativeHandle(ref, () => ({
    reload: () => void load(pathRef.current, true),
    currentPath: () => pathRef.current,
  }), [load])

  useEffect(() => {
    const r = parseHash()
    void load(r.view === 'disk' ? r.path : '')
  }, [load])

  useEffect(() => {
    const onHash = () => {
      const r = parseHash()
      if (r.view !== 'disk') return
      if (r.path !== pathRef.current) void load(r.path)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [load])

  useEffect(() => { onPathChange?.(path) }, [path, onPathChange])

  // ── 派生数据：过滤 + 排序 ────────────────────────────────────────
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? items.filter((e) => e.name.toLowerCase().includes(q)) : items.slice()
    const dir = asc ? 1 : -1
    list.sort((a, b) => {
      // 目录永远在前，文件管理器的通行约定
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      switch (sort) {
        case 'size': return (a.size - b.size) * dir
        case 'mtime': return (a.mtime - b.mtime) * dir
        case 'type': return kindLabel(a.name, a.is_dir).localeCompare(kindLabel(b.name, b.is_dir), 'zh-CN') * dir
        default: return a.name.localeCompare(b.name, 'zh-CN') * dir
      }
    })
    return list
  }, [items, query, sort, asc])

  const stats = useMemo(() => {
    const dirs = items.filter((e) => e.is_dir).length
    const total = items.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0)
    return { dirs, files: items.length - dirs, total }
  }, [items])

  const allChecked = visible.length > 0 && visible.every((e) => selected.has(e.name))
  const selectedEntries = items.filter((i) => selected.has(i.name))
  const selectedSize = selectedEntries.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0)
  const crumb = buildBreadcrumb(path)

  // ── 导航 ────────────────────────────────────────────────────────
  function goUp() { if (path) void load(parentPath(path)) }
  function goBack() { window.history.back() }
  function goForward() { window.history.forward() }
  function refresh() { void load(path) }

  function commitPath() {
    setPathEditing(false)
    const raw = pathDraft.trim().replace(/^[/\\]+/, '')
    if (raw !== path) void load(raw)
  }

  // ── 选择 ────────────────────────────────────────────────────────
  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    const i = visible.findIndex((e) => e.name === name)
    if (i >= 0) anchorRef.current = i
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(visible.map((e) => e.name)))
    anchorRef.current = null
  }

  /** Ctrl / Shift 多选，普通单击只选中该项 */
  function handleRowClick(entry: Entry, e: React.MouseEvent) {
    const i = visible.findIndex((v) => v.name === entry.name)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      toggleSelect(entry.name)
      return
    }
    if (e.shiftKey && anchorRef.current !== null) {
      e.preventDefault()
      const [from, to] = [anchorRef.current, i].sort((a, b) => a - b)
      setSelected((prev) => {
        const next = new Set(prev)
        for (let k = from; k <= to; k++) next.add(visible[k].name)
        return next
      })
      return
    }
    anchorRef.current = i
    setSelected(new Set([entry.name]))
  }

  // ── 写操作 ──────────────────────────────────────────────────────
  async function doMkdir(name: string) {
    setBusy(true)
    try {
      await api.mkdir(path, name)
      toast.success('文件夹已创建', name)
      setMkdirOpen(false)
      await load(path, true)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.friendly : '创建失败')
    } finally { setBusy(false) }
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
    } finally { setBusy(false) }
  }

  async function doDelete(entries: Entry[]) {
    setBusy(true)
    try {
      const res = await api.remove(entries.map((e) => e.path))
      const failedCount = res.failed?.length ?? 0
      if (failedCount === 0) toast.success(`已删除 ${entries.length - failedCount} 项`)
      else toast.warning(`已删除 ${entries.length - failedCount} 项，${failedCount} 项失败`, res.failed?.[0]?.error)
      setDeleting(null)
      await load(path, true)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.friendly : '删除失败')
    } finally { setBusy(false) }
  }

  /** 批量下载：逐个触发浏览器下载，不引 zip 依赖 */
  async function doDownloadSelected() {
    const files = selectedEntries.filter((e) => !e.is_dir)
    const dirCount = selectedEntries.length - files.length
    if (!files.length) {
      toast.warning('所选内容都是文件夹', '文件夹需进入后再选择其中的文件')
      return
    }
    setBatchBusy(true)
    let done = 0, failed = 0
    for (const f of files) {
      try { await api.download(f.path, f.name); done++ } catch { failed++ }
      setBatchProgress(Math.round(((done + failed) / files.length) * 100))
      await new Promise((r) => setTimeout(r, 350))
    }
    setBatchBusy(false)
    setBatchProgress(0)
    if (failed === 0) toast.success(`已下载 ${done} 个文件`, dirCount ? `跳过 ${dirCount} 个文件夹` : undefined)
    else toast.warning(`下载完成 ${done} 个，${failed} 个失败`, dirCount ? `跳过 ${dirCount} 个文件夹` : undefined)
  }

  async function downloadOne(entry: Entry) {
    const id = toast.info(`开始下载 ${entry.name}`, '准备中…')
    try {
      await api.download(entry.path, entry.name, (loaded, total) => {
        if (!total) return
        const pct = Math.round((loaded / total) * 100)
        toast.dismiss(id)
        if (pct < 100) toast.info(`下载中 ${pct}%`, entry.name)
      })
      toast.success('下载完成', entry.name)
    } catch (err) {
      toast.error('下载失败', err instanceof ApiError ? err.friendly : '请重试')
    }
  }

  function openOrPreview(entry: Entry) {
    if (entry.is_dir) void load(entry.path)
    else setPreview(entry)
  }

  function requestDelete(entries: Entry[]) {
    if (entries.length) setDeleting(entries)
  }

  // ── 上下文菜单 / 抽屉条目 ─────────────────────────────────────────
  function buildMenuItems(entry: Entry | null): MenuItem[] {
    if (!entry) {
      return [
        { key: 'refresh', label: '刷新', icon: ICONS.refresh, kbd: 'F5', onClick: refresh },
        { key: 'sep1', label: '', separator: true, onClick: () => {} },
        { key: 'mkdir', label: '新建文件夹', icon: ICONS.folderPlus, onClick: () => setMkdirOpen(true) },
        { key: 'upload', label: '上传文件', icon: ICONS.upload, onClick: () => onRequestUpload?.() },
        { key: 'selectall', label: '全选', icon: ICONS.selectAll, kbd: 'Ctrl+A', onClick: toggleAll },
      ]
    }
    const list: MenuItem[] = [
      {
        key: 'open', label: entry.is_dir ? '打开' : '预览', icon: entry.is_dir ? ICONS.folder : ICONS.eye,
        onClick: () => openOrPreview(entry),
      },
    ]
    if (!entry.is_dir) {
      list.push({ key: 'download', label: '下载', icon: ICONS.download, onClick: () => void downloadOne(entry) })
    }
    list.push(
      { key: 'sep1', label: '', separator: true, onClick: () => {} },
      { key: 'share', label: '分享', icon: ICONS.share, onClick: () => setShareFor(entry) },
      { key: 'rename', label: '重命名', icon: ICONS.rename, kbd: 'F2', disabled: uploading, onClick: () => setRenaming(entry) },
      { key: 'copyPath', label: '复制路径', icon: ICONS.copy, onClick: () => void copyText(entry.path) },
      { key: 'sep2', label: '', separator: true, onClick: () => {} },
      { key: 'delete', label: '删除', icon: ICONS.trash, kbd: 'Delete', danger: true, disabled: uploading, onClick: () => requestDelete([entry]) },
    )
    return list
  }

  function buildSheetItems(entry: Entry): SheetItem[] {
    const list: SheetItem[] = []
    if (!entry.is_dir) {
      list.push({ key: 'preview', label: '预览', icon: ICONS.eye, onClick: () => setPreview(entry) })
      list.push({ key: 'download', label: '下载', icon: ICONS.download, onClick: () => void downloadOne(entry) })
    }
    list.push(
      { key: 'share', label: '分享', icon: ICONS.share, onClick: () => setShareFor(entry) },
      { key: 'rename', label: '重命名', icon: ICONS.rename, disabled: uploading, onClick: () => setRenaming(entry) },
      { key: 'delete', label: '删除', icon: ICONS.trash, danger: true, disabled: uploading, onClick: () => requestDelete([entry]) },
    )
    return list
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success('路径已复制', text) }
    catch { toast.warning('复制失败') }
  }

  // ── 键盘快捷键 ──────────────────────────────────────────────────
  const anyModalOpen = !!(preview || renaming || deleting || mkdirOpen || sheetFor || shareFor)
  useEffect(() => {
    if (anyModalOpen || pathEditing) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const ctrl = e.metaKey || e.ctrlKey

      if (e.key === 'F5') { e.preventDefault(); refresh(); return }
      if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelected(new Set(visible.map((i) => i.name)))
        anchorRef.current = null
        return
      }
      if (e.key === 'Backspace' && path) { e.preventDefault(); goUp(); return }
      if (e.key === 'Delete' && selected.size) { e.preventDefault(); requestDelete(selectedEntries); return }
      if (e.key === 'F2' && selected.size === 1) {
        e.preventDefault()
        setRenaming(selectedEntries[0])
        return
      }
      if (e.key === 'Escape') { setSelected(new Set()); anchorRef.current = null; setQuery('') }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyModalOpen, pathEditing, path, selected, items, visible, query])

  // ── 排序 ────────────────────────────────────────────────────────
  function sortBy(k: SortKey) {
    if (sort === k) setAsc((v) => !v)
    else { setSort(k); setAsc(true) }
  }

  const TH: { key: SortKey; label: string; cls?: string; align?: boolean }[] = [
    { key: 'name', label: '名称' },
    { key: 'mtime', label: '修改日期', cls: 'win-hide-md' },
    { key: 'type', label: '类型', cls: 'win-hide-md' },
    { key: 'size', label: '大小', cls: 'win-hide-sm', align: true },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col" onClick={() => menu && setMenu(null)}>
      {/* ═══ 命令栏：常驻操作，按钮带文字 ═══ */}
      <div className="win-toolbar">
        <ToolButton label="新建文件夹" icon={<Icon d={ICONS.folderPlus} className="size-4" />} onClick={() => setMkdirOpen(true)} />
        <ToolButton label="上传" icon={<Icon d={ICONS.upload} className="size-4" />} onClick={onRequestUpload} />
        <div className="win-tool-sep" />
        <ToolButton label="刷新" icon={<Icon d={ICONS.refresh} className="size-4" />} onClick={refresh} title="刷新（F5）" />
        <ToolButton
          label={allChecked ? '取消全选' : '全选'}
          icon={<Icon d={ICONS.selectAll} className="size-4" />}
          onClick={toggleAll}
          title="全选（Ctrl+A）"
        />
        <div className="win-tool-sep" />
        <ToolButton
          label={batchBusy ? `下载中 ${batchProgress}%` : '下载'}
          icon={<Icon d={ICONS.download} className="size-4" />}
          onClick={() => void doDownloadSelected()}
          disabled={!selected.size || batchBusy}
          title="下载所选文件"
        />
        <ToolButton
          label="重命名"
          icon={<Icon d={ICONS.rename} className="size-4" />}
          onClick={() => selected.size === 1 && setRenaming(selectedEntries[0])}
          disabled={selected.size !== 1 || !!uploading}
          title="重命名（F2）"
        />
        <ToolButton
          label="分享"
          icon={<Icon d={ICONS.share} className="size-4" />}
          onClick={() => {
            const t = selected.size === 1
              ? selectedEntries[0]
              : ({ name: path ? path.split('/').pop()! : '根目录', path, is_dir: true } as Entry)
            setShareFor(t)
          }}
          disabled={!path && !selected.size}
          title="分享选中的文件或当前目录"
        />
        <ToolButton
          label="删除"
          icon={<Icon d={ICONS.trash} className="size-4" />}
          danger
          onClick={() => requestDelete(selectedEntries)}
          disabled={!selected.size || !!uploading}
          title="删除（Delete）"
        />

        {/* 搜索框靠右；窄屏独占一行铺满，避免被挤压裁切 */}
        <div className="relative ml-auto w-[190px] min-w-[130px] max-sm:ml-0 max-sm:w-full max-sm:basis-full">
          <Icon d={ICONS.search} className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[--color-ink-faint]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            aria-label="搜索当前目录"
            className="field !h-[28px] !py-0 !pr-7 !pl-8 !text-[12px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-[--color-ink-faint] hover:text-[--color-ink]"
              aria-label="清除搜索"
            >
              <Icon d={ICONS.close} className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* ═══ 地址栏 ═══ */}
      <div className="win-address">
        <button type="button" className="win-nav-btn" onClick={goBack} title="后退" aria-label="后退">
          <Icon d={ICONS.chevronLeft} className="size-4" />
        </button>
        <button type="button" className="win-nav-btn" onClick={goForward} title="前进" aria-label="前进">
          <Icon d={ICONS.chevronRight} className="size-4" />
        </button>
        <button type="button" className="win-nav-btn" onClick={goUp} disabled={!path} title="上一级（Backspace）" aria-label="上一级">
          <Icon d={ICONS.arrowUp} className="size-4" />
        </button>
        <button type="button" className="win-nav-btn" onClick={refresh} title="刷新（F5）" aria-label="刷新">
          <Icon d={ICONS.refresh} className="size-3.5" />
        </button>

        {/* 面包屑：点空白处切成可编辑路径 */}
        <div
          className="win-crumbs"
          title="点击此处可直接输入路径"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return
            setPathDraft(path)
            setPathEditing(true)
          }}
        >
          {pathEditing ? (
            <input
              className="win-path-input"
              value={pathDraft}
              autoFocus
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => setPathEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPath()
                if (e.key === 'Escape') setPathEditing(false)
              }}
              aria-label="路径"
            />
          ) : (
            <>
              <button type="button" className={cn('win-crumb', !path && 'is-current')} onClick={() => void load('')}>
                <Icon d={ICONS.drive} className="size-3.5" />
                此电脑
              </button>
              {crumb.map((c, i) => (
                <span key={c.path} className="contents">
                  <span className="win-crumb-sep">›</span>
                  <button
                    type="button"
                    className={cn('win-crumb', i === crumb.length - 1 && 'is-current')}
                    onClick={() => void load(c.path)}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </>
          )}
        </div>
      </div>

      {/* ═══ 列表 ═══ */}
      <div className="win-table min-h-0 flex-1 overflow-auto" data-dropzone-inner="">
        {/* 列头 */}
        <div className="win-thead">
          <div className="flex items-center justify-center">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              disabled={!visible.length}
              aria-label="全选"
            />
          </div>
          {TH.map((th) => (
            <button
              key={th.key}
              type="button"
              onClick={() => sortBy(th.key)}
              className={cn('win-th', th.cls, sort === th.key && 'is-sorted', th.align && 'justify-end')}
              title={`按${th.label}排序`}
            >
              {th.label}
              {sort === th.key && (
                <Icon d={asc ? ICONS.arrowUp : ICONS.arrowDown} className="size-3 shrink-0" />
              )}
            </button>
          ))}
          <div className="win-th !cursor-default justify-end">操作</div>
        </div>

        {/* 内容 */}
        {loading ? (
          <SkeletonRows rows={9} />
        ) : error ? (
          <EmptyState
            icon={ICONS.info}
            title="无法打开此文件夹"
            hint={error}
            action={<Button onClick={() => void load(path)} icon={<Icon d={ICONS.refresh} className="size-3.5" />}>重试</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={query ? ICONS.search : ICONS.folder}
            title={query ? '没有匹配的项目' : '此文件夹为空'}
            hint={query ? `没有找到与「${query}」匹配的项目` : '把文件拖到这里，或点命令栏的「上传」'}
            action={query ? (
              <Button onClick={() => setQuery('')}>清除搜索</Button>
            ) : (
              <Button variant="primary" onClick={onRequestUpload} icon={<Icon d={ICONS.upload} className="size-3.5" />}>上传文件</Button>
            )}
          />
        ) : (
          <div
            onContextMenu={(e) => {
              // 行已自行处理；这里只在空白处右键
              if ((e.target as HTMLElement).closest('[data-file-row]')) return
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, entry: null })
            }}
          >
            {visible.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={selected.has(entry.name)}
                uploading={!!uploading}
                onToggleSelect={toggleSelect}
                onRowClick={handleRowClick}
                onActivate={openOrPreview}
                onPreview={setPreview}
                onRename={setRenaming}
                onDelete={(e) => requestDelete([e])}
                onShare={setShareFor}
                onContextMenu={(en, x, y) => setMenu({ x, y, entry: en })}
                onLongPress={setSheetFor}
              />
            ))}
          </div>
        )}
      </div>

      {/* ═══ 状态栏 ═══ */}
      <div className="win-statusbar">
        <span>{loading ? '正在读取…' : `${stats.dirs + stats.files} 个项目`}</span>
        <span className="sep">|</span>
        <span>{stats.dirs} 个文件夹 · {stats.files} 个文件</span>
        {stats.total > 0 && <><span className="sep">|</span><span>{humanSize(stats.total)}</span></>}
        {selected.size > 0 && (
          <>
            <span className="sep">|</span>
            <span className="font-semibold text-[--color-accent]">已选 {selected.size} 项</span>
            {selectedSize > 0 && <span>（{humanSize(selectedSize)}）</span>}
          </>
        )}
        {query && <><span className="sep">|</span><span>筛选出 {visible.length} 项</span></>}
        <span className="ml-auto truncate-1 text-[--color-ink-faint]" title={path}>
          {path ? `/${path}` : '根目录'}
        </span>
      </div>

      {/* ═══ 弹窗 ═══ */}
      <ShareModal
        open={!!shareFor}
        onClose={() => setShareFor(null)}
        targetPath={shareFor?.path ?? ''}
        targetName={shareFor?.name ?? ''}
        isDir={!!shareFor?.is_dir}
        onManage={() => {
          setShareFor(null)
          window.location.hash = '/shares'
        }}
      />
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
        message={deleting && deleting.length === 1
          ? `确定要删除「${deleting[0].name}」吗？`
          : `确定要删除选中的 ${deleting?.length ?? 0} 项吗？`}
        detail={deleting?.some((e) => e.is_dir)
          ? '包含文件夹，其中的所有内容会一并删除。此操作无法撤销。'
          : '删除后无法恢复。'}
        confirmText="删除"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void doDelete(deleting)}
      />

      <ActionSheet
        open={!!sheetFor}
        onClose={() => setSheetFor(null)}
        title={sheetFor?.name}
        subtitle={sheetFor ? (sheetFor.is_dir ? '文件夹' : sheetFor.size_h) : undefined}
        items={sheetFor ? buildSheetItems(sheetFor) : []}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
})

export default FileBrowser
