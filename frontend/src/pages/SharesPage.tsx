/**
 * 分享管理页（需登录）—— 表格化集中控制所有公开链接。
 *
 * 列：目标 / 类型 / 状态 / 创建 / 有效期 / 链接 / 操作
 * 操作常驻（复制链接 / 停用启用 / 撤销），不依赖 hover。
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { ShareRecord } from '../types/api'
import { useToast } from '../context/ToastContext'
import { navigate } from '../lib/router'
import { Button, EmptyState, Icon, ICONS, SkeletonRows, ToolButton } from '../components/ui'
import { cn } from '../lib/utils'

function absoluteLink(url: string): string {
  if (/^https?:\/\//.test(url)) return url
  return `${window.location.origin}${url}`
}

export default function SharesPage() {
  const toast = useToast()
  const [items, setItems] = useState<ShareRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.listShares()
      setItems(res.items || [])
    } catch (err) {
      setError(err instanceof ApiError ? err.friendly : '加载失败')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function copy(rec: ShareRecord) {
    try {
      await navigator.clipboard.writeText(absoluteLink(rec.url))
      toast.success('链接已复制', absoluteLink(rec.url))
    } catch {
      toast.warning('复制失败', '请手动复制下方链接')
    }
  }

  async function toggle(rec: ShareRecord) {
    try {
      await api.toggleShare(rec.id, !rec.enabled)
      toast.success(rec.enabled ? '已停用' : '已启用')
      setItems((prev) => prev.map((i) => (i.id === rec.id ? { ...i, enabled: !rec.enabled } : i)))
    } catch (err) {
      toast.error('操作失败', err instanceof ApiError ? err.friendly : '请重试')
    }
  }

  async function revoke(rec: ShareRecord) {
    try {
      await api.revokeShare(rec.id)
      toast.success('已撤销分享')
      setItems((prev) => prev.filter((i) => i.id !== rec.id))
    } catch (err) {
      toast.error('撤销失败', err instanceof ApiError ? err.friendly : '请重试')
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[--color-canvas]">
      {/* 标题栏 */}
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-[--color-line] bg-white px-3">
        <button
          type="button"
          onClick={() => navigate({ view: 'disk', path: '' })}
          className="win-nav-btn"
          aria-label="返回网盘"
          title="返回网盘"
        >
          <Icon d={ICONS.back} className="size-4" />
        </button>
        <h1 className="text-[13px] font-semibold text-[--color-ink]">分享管理</h1>
        <span className="text-[11.5px] text-[--color-ink-faint]">
          {loading ? '读取中…' : `共 ${items.length} 条 · 有效 ${items.filter((i) => i.active).length} 条`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ToolButton label="刷新" icon={<Icon d={ICONS.refresh} className="size-4" />} onClick={() => void refresh()} />
          <ToolButton label="返回网盘" icon={<Icon d={ICONS.drive} className="size-4" />} onClick={() => navigate({ view: 'disk', path: '' })} />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-2 max-sm:p-0">
        <div className="win-panel mx-auto flex min-h-0 max-w-6xl flex-col overflow-hidden">
          {loading ? (
            <SkeletonRows rows={6} />
          ) : error ? (
            <EmptyState
              icon={ICONS.info}
              title="无法读取分享列表"
              hint={error}
              action={<Button onClick={() => void refresh()}>重试</Button>}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={ICONS.share}
              title="还没有分享"
              hint="在文件上点「分享」即可生成一条公开链接"
              action={
                <Button variant="primary" onClick={() => navigate({ view: 'disk', path: '' })} icon={<Icon d={ICONS.folder} className="size-3.5" />}>
                  去网盘分享
                </Button>
              }
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead className="sticky top-0 z-10 bg-[--color-surface-alt]">
                  <tr className="h-[30px] border-b border-[--color-line] text-left text-[12px] font-semibold text-[--color-ink-soft]">
                    <th className="px-3 font-semibold">目标</th>
                    <th className="w-[72px] px-3 font-semibold">类型</th>
                    <th className="w-[76px] px-3 font-semibold">状态</th>
                    <th className="w-[110px] px-3 font-semibold max-lg:hidden">创建时间</th>
                    <th className="w-[100px] px-3 font-semibold max-lg:hidden">有效期</th>
                    <th className="px-3 font-semibold max-md:hidden">公开链接</th>
                    <th className="w-[190px] px-3 text-right font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((rec) => {
                    const status = !rec.enabled
                      ? { label: '已停用', cls: 'bg-[#eef0f3] text-[--color-ink-soft] border-[--color-line]' }
                      : rec.expired
                        ? { label: '已过期', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                        : { label: '有效', cls: 'bg-emerald-50 text-[--color-success] border-emerald-200' }
                    return (
                      <tr key={rec.id} className="h-[38px] border-b border-[#f0f2f4] hover:bg-[#f5f8fc]">
                        <td className="px-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <Icon d={rec.is_dir ? ICONS.folder : ICONS.file} className={cn('size-4 shrink-0', rec.is_dir ? 'text-amber-600' : 'text-[--color-ink-faint]')} />
                            <span className="truncate-1 font-medium text-[--color-ink]" title={rec.path}>{rec.path || '根目录'}</span>
                          </div>
                        </td>
                        <td className="px-3 text-[--color-ink-soft]">{rec.is_dir ? '目录' : '文件'}</td>
                        <td className="px-3">
                          <span className={cn('chip border', status.cls)}>{status.label}</span>
                        </td>
                        <td className="px-3 text-[--color-ink-soft] max-lg:hidden">{rec.created_h}</td>
                        <td className="px-3 text-[--color-ink-soft] max-lg:hidden">{rec.expires_at ? rec.expires_h : '永久'}</td>
                        <td className="px-3 max-md:hidden">
                          <code className="block max-w-[260px] truncate-1 text-[11.5px] text-[--color-ink-faint]" title={absoluteLink(rec.url)}>
                            {absoluteLink(rec.url)}
                          </code>
                        </td>
                        <td className="px-3">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="primary" onClick={() => void copy(rec)} icon={<Icon d={ICONS.copy} className="size-3" />}>
                              复制链接
                            </Button>
                            <Button size="sm" onClick={() => void toggle(rec)} icon={<Icon d={ICONS.shield} className="size-3" />}>
                              {rec.enabled ? '停用' : '启用'}
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => void revoke(rec)} icon={<Icon d={ICONS.trash} className="size-3" />}>
                              撤销
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      <div className="win-statusbar">
        <span>公开链接是免登录入口，任何拿到链接的人都能访问对应内容</span>
        <span className="ml-auto">不再需要时请及时撤销</span>
      </div>
    </div>
  )
}
