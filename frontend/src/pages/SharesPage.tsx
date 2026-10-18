/**
 * 分享管理页（需登录）。
 *
 * 在这里集中查看 / 控制所有分享链接：
 *   - 复制公开链接
 *   - 启用 / 禁用（禁用后链接立即 404）
 *   - 撤销（彻底删除记录）
 *
 * 链接本身是凭 token 访问的公开入口，无需登录即可打开。
 */

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { ShareRecord } from '../types/api'
import { useToast } from '../context/ToastContext'
import { navigate } from '../lib/router'
import { Button, Icon, ICONS } from '../components/ui'

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

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function copy(rec: ShareRecord) {
    try {
      await navigator.clipboard.writeText(absoluteLink(rec.url))
      toast.success('链接已复制')
    } catch {
      toast.warning('复制失败', '请手动复制下方链接')
    }
  }

  async function toggle(rec: ShareRecord) {
    try {
      await api.toggleShare(rec.id, !rec.enabled)
      toast.success(rec.enabled ? '已停用' : '已启用')
      setItems((prev) =>
        prev.map((i) => (i.id === rec.id ? { ...i, enabled: !rec.enabled } : i)),
      )
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
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 bg-[--color-canvas]">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-4">
          <button
            type="button"
            onClick={() => navigate({ view: 'disk' })}
            className="grid size-9 shrink-0 place-items-center rounded-full border-2 border-slate-200 text-slate-500 transition-colors hover:border-[--color-sky-400] hover:text-[--color-sky-600]"
            aria-label="返回网盘"
          >
            <Icon d={ICONS.back} />
          </button>

          <div className="min-w-0">
            <h1 className="truncate-1 text-xl font-black text-slate-800 sm:text-2xl">分享管理</h1>
            <p className="text-xs font-bold text-slate-400">
              {loading ? '加载中…' : `共 ${items.length} 条 · 有效 ${items.filter((i) => i.active).length} 条`}
            </p>
          </div>

          <Button
            onClick={() => navigate({ view: 'disk' })}
            size="sm"
            className="ml-auto"
            icon={<Icon d={ICONS.home} className="size-3.5" />}
          >
            网盘
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-10 sm:px-4">
        {loading ? (
          <div className="space-y-3 py-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        ) : error ? (
          <div className="cute-border mt-4 rounded-2xl bg-white p-8 text-center">
            <p className="text-sm font-bold text-slate-500">{error}</p>
            <Button className="mt-4" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="cute-border mt-4 rounded-2xl bg-white p-10 text-center">
            <div className="mb-2 text-4xl opacity-50">🔗</div>
            <p className="text-base font-black text-slate-700">还没有分享</p>
            <p className="mt-1 text-xs font-medium text-slate-400">
              在文件上点「分享」即可生成一条公开链接
            </p>
            <Button
              variant="primary"
              className="mt-5"
              onClick={() => navigate({ view: 'disk' })}
              icon={<Icon d={ICONS.folder} className="size-3.5" />}
            >
              去网盘分享
            </Button>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((rec) => {
              const status = !rec.enabled
                ? { label: '已停用', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
                : rec.expired
                  ? { label: '已过期', cls: 'bg-amber-50 text-amber-600 border-amber-200' }
                  : { label: '有效', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' }
              return (
                <li
                  key={rec.id}
                  className="cute-border rounded-2xl bg-white p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[--color-sky-100] text-[--color-sky-600]">
                      <Icon d={rec.is_dir ? ICONS.folder : ICONS.file} className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate-1 text-sm font-black text-slate-800">
                          {rec.path || '根目录'}
                        </p>
                        <span
                          className={
                            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ' +
                            status.cls
                          }
                        >
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] font-medium text-[--color-ink-faint]">
                        {rec.is_dir ? '目录分享' : '文件分享'} · 创建于 {rec.created_h}
                        {rec.expires_at ? ` · ${rec.expires_h} 过期` : ' · 永久有效'}
                      </p>
                      <p className="mt-1 truncate-1 text-[11px] text-slate-400" title={absoluteLink(rec.url)}>
                        {absoluteLink(rec.url)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void copy(rec)}
                      icon={<Icon d={ICONS.copy} className="size-3.5" />}
                    >
                      复制链接
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void toggle(rec)}
                      icon={<Icon d={ICONS.shield} className="size-3.5" />}
                    >
                      {rec.enabled ? '停用' : '启用'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void revoke(rec)}
                      icon={<Icon d={ICONS.trash} className="size-3.5" />}
                    >
                      撤销
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}
