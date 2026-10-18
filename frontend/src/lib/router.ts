/**
 * 极简 hash 路由。
 *
 * 为什么用 hash 而不是 History API 的 path 路由：
 *   - 服务端永远是「只服务 /（index.html）」，目录切换全在客户端完成。
 *     这样无论后端自带网页、Vercel、还是任意静态托管，分享链接 / 目录链接
 *     都能直接打开，无需任何 SPA fallback 配置。
 *   - 浏览器前进/后退天然支持（hashchange 事件）。
 *
 * 路由形态：
 *   #/d/<path>            磁盘浏览器，path 为相对存储根的路径（已 encodeURIComponent）
 *   #/shares              分享管理页（需登录）
 *   #/s/<token>           公开分享查看（免登录）
 *   #/s/<token>/<sub>     公开分享的子目录浏览，sub 为分享内相对子路径
 *   其它 / 空            视为磁盘根目录
 */

export type RouteView = 'disk' | 'shares' | 'share'

export interface RouteState {
  view: RouteView
  /** 磁盘浏览器的当前目录（相对路径） */
  path: string
  /** 公开分享的 token */
  token: string
  /** 公开分享内的相对子路径（仅目录分享有） */
  sharePath: string
}

const EMPTY: RouteState = { view: 'disk', path: '', token: '', sharePath: '' }

/** 解析当前 location.hash 为路由状态。 */
export function parseHash(hash: string = window.location.hash): RouteState {
  const raw = hash.replace(/^#/, '')
  if (!raw) return { ...EMPTY }

  const parts = raw.split('/').filter((s) => s !== '')
  if (parts.length === 0) return { ...EMPTY }

  if (parts[0] === 'd') {
    const segs = parts.slice(1).map(safeDecode)
    return { ...EMPTY, view: 'disk', path: segs.join('/') }
  }

  if (parts[0] === 'shares') {
    return { ...EMPTY, view: 'shares' }
  }

  if (parts[0] === 's' && parts[1]) {
    const token = parts[1]
    const sub = parts.slice(2).map(safeDecode).join('/')
    return { ...EMPTY, view: 'share', token, sharePath: sub }
  }

  return { ...EMPTY }
}

/** 构造 hash 字符串（不含前导 #）。 */
export function buildHash(state: Partial<RouteState>): string {
  const view = state.view ?? 'disk'
  if (view === 'shares') return '/shares'
  if (view === 'share') {
    // token 本身 URL 安全（token_urlsafe）；sub 逐段编码后用字面 / 连接，
    // 路径段里不可能含 /（文件系统限制），这样链接更干净。
    const sub = state.sharePath
      ? '/' + state.sharePath.split('/').map(encodeURIComponent).join('/')
      : ''
    return `/s/${state.token ?? ''}${sub}`
  }
  // disk：逐段编码后用字面 / 连接，避免出现 %2F
  const p = state.path
    ? '/' + state.path.split('/').map(encodeURIComponent).join('/')
    : ''
  return `/d${p}`
}

/** 跳转路由（写 hash）。 */
export function navigate(state: Partial<RouteState>): void {
  const next = buildHash(state)
  if (window.location.hash !== `#${next}`) {
    window.location.hash = next
  }
}

/** 把当前磁盘目录同步进 hash（供导航时调用）。 */
export function syncDiskPath(path: string): void {
  navigate({ view: 'disk', path })
}

/** 进入分享的某个子目录（用于公开分享内的面包屑 / 点击文件夹）。 */
export function shareNavigate(token: string, sub: string): void {
  navigate({ view: 'share', token, sharePath: sub })
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 订阅路由变化。返回取消订阅函数。
 *
 * 同时在 mount 时立即回调一次当前状态，避免调用方重复写同样的初始化逻辑。
 */
export function useHashRoute(onChange: (state: RouteState) => void): () => void {
  const handler = () => onChange(parseHash())
  window.addEventListener('hashchange', handler)
  return () => window.removeEventListener('hashchange', handler)
}
