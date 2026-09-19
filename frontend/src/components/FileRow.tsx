/**
 * 单个目录项（文件或文件夹）的行。
 *
 * 交互：
 *   - 双击（桌面）或单击（触屏）→ 进入目录 / 预览文件
 *   - 悬停显示操作按钮：下载、重命名、删除
 *   - 勾选模式下显示复选框
 */

import type { Entry } from '../types/api'
import { cn, fullDate, humanDate, iconBgOf, iconOf, isImage } from '../lib/utils'
import { Icon, ICONS, IconButton } from './ui'
import { api } from '../api/client'

interface Props {
  entry: Entry
  selected: boolean
  selectMode: boolean
  onToggleSelect(name: string): void
  onOpen(entry: Entry): void
  onPreview(entry: Entry): void
  onRename(entry: Entry): void
  onDelete(entry: Entry): void
}

export default function FileRow({
  entry,
  selected,
  selectMode,
  onToggleSelect,
  onOpen,
  onPreview,
  onRename,
  onDelete,
}: Props) {
  const kindBg = iconBgOf(entry.name, entry.is_dir)
  const showThumb = isImage(entry.name)

  function handleClick() {
    if (selectMode) onToggleSelect(entry.name)
    else if (entry.is_dir) onOpen(entry)
    else onPreview(entry)
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
        'hover:bg-white/90',
        selected && 'bg-[--color-brand-50] ring-1 ring-[--color-brand-200]',
      )}
    >
      {/* 选中态高亮条 */}
      {selected && (
        <span className="absolute top-1/2 left-0 h-6 w-0.5 -translate-y-1/2 rounded-full bg-[--color-brand-500]" />
      )}

      {/* 复选框 / 图标 */}
      <div className="flex shrink-0 items-center gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(entry.name)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择 ${entry.name}`}
          className={cn(
            'size-4 cursor-pointer rounded border-slate-300 accent-[--color-brand-500] transition-opacity',
            selectMode || selected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        />

        <button
          type="button"
          onClick={handleClick}
          className={cn(
            'grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl text-base',
            kindBg,
            !selectMode && 'cursor-pointer',
          )}
          aria-label={entry.is_dir ? `进入 ${entry.name}` : `预览 ${entry.name}`}
        >
          {showThumb ? (
            <img
              src={api.downloadUrl(entry.path)}
              alt=""
              loading="lazy"
              className="size-full object-cover"
              onError={(e) => {
                // 缩略图失败就退回 emoji，不让破图影响观感
                const el = e.currentTarget
                el.style.display = 'none'
                el.parentElement?.classList.add('text-base')
              }}
            />
          ) : (
            <span aria-hidden>{iconOf(entry.name, entry.is_dir)}</span>
          )}
        </button>
      </div>

      {/* 名称与元信息 */}
      <button
        type="button"
        onClick={handleClick}
        className="min-w-0 flex-1 text-left"
        aria-label={entry.is_dir ? `进入 ${entry.name}` : `预览 ${entry.name}`}
      >
        <p className="truncate-1 text-sm font-bold text-[--color-ink]">{entry.name}</p>
        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-[--color-ink-faint]">
          <span className="truncate-1" title={fullDate(entry.mtime)}>
            {humanDate(entry.mtime)}
          </span>
          {!entry.is_dir && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{entry.size_h}</span>
            </>
          )}
          {entry.is_dir && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">文件夹</span>
            </>
          )}
        </p>
      </button>

      {/* 操作区：悬停或选中时出现 */}
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        {!entry.is_dir && (
          <>
            <IconButton
              label="预览"
              onClick={(e) => {
                e.stopPropagation()
                onPreview(entry)
              }}
            >
              <Icon d={ICONS.eye} />
            </IconButton>
            <a
              href={api.downloadUrl(entry.path)}
              download={entry.name}
              title="下载"
              aria-label={`下载 ${entry.name}`}
              onClick={(e) => e.stopPropagation()}
              className="grid size-8 place-items-center rounded-full text-[--color-ink-faint] transition-colors hover:bg-slate-100 hover:text-[--color-brand-600]"
            >
              <Icon d={ICONS.download} />
            </a>
          </>
        )}

        <IconButton
          label="重命名"
          onClick={(e) => {
            e.stopPropagation()
            onRename(entry)
          }}
        >
          <Icon d={ICONS.rename} />
        </IconButton>

        <IconButton
          label="删除"
          tone="danger"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(entry)
          }}
        >
          <Icon d={ICONS.trash} />
        </IconButton>
      </div>
    </div>
  )
}
