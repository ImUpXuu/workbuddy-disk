/**
 * 后端 API 客户端。
 *
 * 设计要点：
 *   1. 统一的凭证注入 —— 所有请求自动带上 X-API-Key 或 ?token=
 *   2. 结构化的错误分类 —— 把「网络不通 / CORS 被拦 / 401 / 业务错误」
 *      区分为不同错误类型，UI 才能给出真正有用的提示
 *   3. 401 统一广播 —— 任意请求遇到 401，AuthContext 都能感知并跳登录
 */

import type {
  ApiEnvelope,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyMutateResponse,
  DeleteResponse,
  ListResponse,
  LoginResponse,
  MkdirResponse,
  RenameResponse,
  Settings,
  SettingsResponse,
  StatsResponse,
  UploadCompleteResponse,
  UploadInitResponse,
  UploadResponse,
  WhoamiResponse,
} from '../types/api'

// ═══════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════

/**
 * 后端地址。
 * 优先读构建期环境变量；没配置时回退到同源（方便后端自带的网页版调试）。
 */
export const API_BASE: string = (() => {
  const raw = import.meta.env.VITE_API_BASE as string | undefined
  if (raw) return raw.replace(/\/+$/, '')
  return ''
})()

// ═══════════════════════════════════════════════════════════════════
// 本地存储
// ═══════════════════════════════════════════════════════════════════

const LS_KEY_APIKEY = 'netdisk.apikey'
const LS_KEY_TOKEN = 'netdisk.token'

/**
 * 凭证读取统一走这里。
 *
 * 为什么不用 Cookie：前端在 Vercel（pan.upxuu.com），后端在别的域，
 * 跨站 Cookie（SameSite=Lax）不会被带上，所以走 localStorage + 请求头。
 */
export const credentials = {
  getApiKey(): string {
    try {
      return localStorage.getItem(LS_KEY_APIKEY) || ''
    } catch {
      return ''
    }
  },
  setApiKey(key: string): void {
    try {
      if (key) localStorage.setItem(LS_KEY_APIKEY, key)
      else localStorage.removeItem(LS_KEY_APIKEY)
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  },
  getToken(): string {
    try {
      return localStorage.getItem(LS_KEY_TOKEN) || ''
    } catch {
      return ''
    }
  },
  setToken(token: string): void {
    try {
      if (token) localStorage.setItem(LS_KEY_TOKEN, token)
      else localStorage.removeItem(LS_KEY_TOKEN)
    } catch {
      /* 同上 */
    }
  },
  clear(): void {
    this.setApiKey('')
    this.setToken('')
  },
  /** 有无任何一种凭证 */
  has(): boolean {
    return !!(this.getApiKey() || this.getToken())
  },
}

// ═══════════════════════════════════════════════════════════════════
// 错误类型
// ═══════════════════════════════════════════════════════════════════

export type ApiErrorKind =
  | 'offline'        // 网络不可达 / DNS 失败
  | 'cors'           // 跨域被浏览器拦下（响应拿不到，但请求发出去了）
  | 'unauthorized'   // 401
  | 'forbidden'      // 403（含危险开关拦截）
  | 'notfound'       // 404
  | 'conflict'       // 409
  | 'timeout'        // 超时
  | 'server'         // 5xx
  | 'badrequest'     // 4xx 其他
  | 'aborted'        // 主动取消
  | 'unknown'

export class ApiError extends Error {
  kind: ApiErrorKind
  status: number
  payload?: ApiEnvelope

  constructor(kind: ApiErrorKind, message: string, status = 0, payload?: ApiEnvelope) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.payload = payload
  }

  /** 给用户看的人话 */
  get friendly(): string {
    switch (this.kind) {
      case 'offline':
        return '连不上服务器，请检查网络或后端是否在运行'
      case 'cors':
        return '请求被跨域策略拦下，请确认后端已放行当前站点'
      case 'unauthorized':
        return '凭证无效或已过期，请重新设置 API Key'
      case 'forbidden':
        return this.payload?.dangerous_blocked
          ? '危险操作已被后端开关禁用，请到设置页开启'
          : '没有权限执行此操作'
      case 'notfound':
        return this.payload?.error || '目标不存在'
      case 'conflict':
        return this.payload?.error || '同名内容已存在'
      case 'timeout':
        return '请求超时，请重试'
      case 'server':
        return '服务器出错了，请稍后再试'
      case 'badrequest':
        return this.payload?.error || '请求参数有误'
      case 'aborted':
        return '已取消'
      default:
        return this.payload?.error || this.message || '未知错误'
    }
  }
}

/** 401 事件：让 AuthContext 能感知任意请求的登录失效 */
type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

function emitUnauthorized(): void {
  unauthorizedListeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* 监听器出错不影响主流程 */
    }
  })
}

function classify(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notfound'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'server'
  if (status >= 400) return 'badrequest'
  return 'unknown'
}

// ═══════════════════════════════════════════════════════════════════
// 请求核心
// ═══════════════════════════════════════════════════════════════════

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON body，会自动序列化并设置 Content-Type */
  json?: unknown
  /** FormData，直接透传（不要手动设置 Content-Type，否则 boundary 会丢） */
  form?: FormData
  /** 查询参数，会自动跳过空值 */
  query?: Record<string, string | number | boolean | undefined | null>
  /** 超时毫秒数；0 表示不超时（上传大文件时会用到） */
  timeout?: number
  signal?: AbortSignal
  /** 是否要求必须带凭证；默认 true。登录接口要传 false */
  auth?: boolean
}

/** 把凭证塞进 URL 查询参数（某些场景下 header 不可用时用它兜底） */
function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`
  const params = new URLSearchParams()

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      params.set(k, String(v))
    }
  }

  // 某些反向网关会覆写 Authorization 头，查询参数是最稳的兜底通道。
  // 只在没有 API Key（即用 token 登录）时才拼 token，避免凭证互相干扰。
  const token = credentials.getToken()
  if (token && !credentials.getApiKey() && !params.has('token')) {
    params.set('token', token)
  }

  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

/** 组装请求头：JSON 时设 Content-Type；表单交给浏览器自动带 boundary */
function buildHeaders(isJson: boolean, auth: boolean): Headers {
  const h = new Headers()
  if (isJson) h.set('Content-Type', 'application/json')

  if (auth) {
    const key = credentials.getApiKey()
    if (key) {
      // 前端主通道：跨域自定义头，已列入后端 Allow-Headers
      h.set('X-API-Key', key)
    } else {
      const token = credentials.getToken()
      if (token) h.set('Authorization', `Bearer ${token}`)
    }
  }
  return h
}

/**
 * 发起请求并解析 JSON。
 *
 * 错误处理的难点在于区分「网络不可达」与「跨域被拦」——
 * 两者抛出的都是 TypeError，浏览器出于安全考虑不会告诉 JS 具体原因。
 * 这里用 navigator.onLine 做一次粗判，至少给用户一个有方向的提示。
 */
export async function request<T extends ApiEnvelope>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    json,
    form,
    query,
    timeout = 30_000,
    signal,
    auth = true,
  } = opts

  const url = buildUrl(path, query)
  const headers = buildHeaders(json !== undefined, auth)

  const body: BodyInit | undefined = json !== undefined
    ? JSON.stringify(json)
    : form
      ? form
      : undefined

  // 超时控制：用 AbortController 串联外部 signal，任一触发都中止
  const ac = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, timeout)
  }

  const onExternalAbort = () => ac.abort()
  signal?.addEventListener('abort', onExternalAbort, { once: true })

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: ac.signal,
      // 不用 credentials: 'include' —— 跨站 Cookie 不可靠，
      // 凭证全走请求头/查询参数，见 credentials 对象注释。
    })
  } catch (err) {
    if (timedOut) throw new ApiError('timeout', '请求超时')
    if (signal?.aborted) throw new ApiError('aborted', '已取消')

    // fetch 抛 TypeError 的两种情况无法区分，只能粗判
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    throw new ApiError(
      offline ? 'offline' : 'cors',
      offline ? '网络不可达' : '请求失败，可能是跨域被拦截',
    )
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }

  // 204 无内容
  if (res.status === 204) {
    return { ok: true } as T
  }

  const text = await res.text()
  let payload: ApiEnvelope | undefined
  if (text) {
    try {
      payload = JSON.parse(text) as ApiEnvelope
    } catch {
      // 后端返回了非 JSON（例如网关的 HTML 错误页）
      if (!res.ok) {
        throw new ApiError('server', `服务返回了非 JSON 内容（${res.status}）`, res.status)
      }
      throw new ApiError('unknown', '响应格式无法解析')
    }
  }

  if (!res.ok) {
    const kind = classify(res.status)
    if (kind === 'unauthorized') emitUnauthorized()
    throw new ApiError(kind, payload?.error || `HTTP ${res.status}`, res.status, payload)
  }

  return (payload ?? { ok: true }) as T
}

/** GET + 查询参数 */
function get<T extends ApiEnvelope>(
  path: string,
  query?: RequestOptions['query'],
  opts?: RequestOptions,
): Promise<T> {
  return request<T>(path, { ...opts, method: 'GET', query })
}

/**
 * 以二进制方式请求，返回 Blob。
 *
 * 与 request() 的区别：
 *   - 不解析 JSON，直接取二进制
 *   - 支持进度回调（靠 Content-Length 与 ReadableStream）
 *
 * 进度读取用 ReadableStream 手动累积，因为 fetch 没有原生下载进度事件。
 * 若环境不支持 stream（少数旧浏览器），退化为一次性读取，进度只报 0 与 100%。
 */
async function requestBlob(
  path: string,
  query?: RequestOptions['query'],
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const url = buildUrl(path, query)
  const headers = buildHeaders(false, true)

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers, signal })
  } catch {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    throw new ApiError(offline ? 'offline' : 'cors', offline ? '网络不可达' : '请求失败')
  }

  if (!res.ok) {
    // 错误响应通常是 JSON，尝试解析出可读信息
    let payload: ApiEnvelope | undefined
    try {
      payload = (await res.json()) as ApiEnvelope
    } catch {
      /* 非 JSON 错误页，忽略 */
    }
    const kind = classify(res.status)
    if (kind === 'unauthorized') emitUnauthorized()
    throw new ApiError(kind, payload?.error || `HTTP ${res.status}`, res.status, payload)
  }

  const total = Number(res.headers.get('Content-Length') || 0)

  // 无 stream 支持：一把梭
  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob()
    onProgress?.(blob.size, blob.size)
    return blob
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        loaded += value.byteLength
        onProgress?.(loaded, total || loaded)
      }
    }
  } catch (err) {
    if (signal?.aborted) throw new ApiError('aborted', '已取消')
    throw new ApiError('unknown', '下载中断', 0, undefined)
  }

  return new Blob(chunks as BlobPart[])
}

/** POST + JSON */
function post<T extends ApiEnvelope>(
  path: string,
  json?: unknown,
  query?: RequestOptions['query'],
  opts?: RequestOptions,
): Promise<T> {
  return request<T>(path, { ...opts, method: 'POST', json, query })
}

// ═══════════════════════════════════════════════════════════════════
// 业务接口
// ═══════════════════════════════════════════════════════════════════

export const api = {
  // ── 鉴权 ──────────────────────────────────────────────────────

  /** 用登录密钥换 token。这是唯一不需要凭证的接口。 */
  login(key: string): Promise<LoginResponse> {
    return post<LoginResponse>('/api/login', { key }, undefined, { auth: false, timeout: 15_000 })
  },

  /** 查当前凭证是否有效 */
  whoami(): Promise<WhoamiResponse> {
    return get<WhoamiResponse>('/api/whoami', undefined, { timeout: 10_000 })
  },

  // ── 浏览 ──────────────────────────────────────────────────────

  /** 列目录 */
  list(path = ''): Promise<ListResponse> {
    return get<ListResponse>('/api/list', { path })
  },

  /** 存储统计 */
  stats(): Promise<StatsResponse> {
    return get<StatsResponse>('/api/stats')
  },

  // ── 文件操作 ──────────────────────────────────────────────────

  /** 新建文件夹 */
  mkdir(path: string, name: string): Promise<MkdirResponse> {
    return post<MkdirResponse>('/api/mkdir', { path, name })
  },

  /** 重命名 / 移动（new_name 含斜杠即为移动） */
  rename(path: string, newName: string): Promise<RenameResponse> {
    return post<RenameResponse>('/api/rename', { path, new_name: newName })
  },

  /** 删除（支持批量） */
  remove(paths: string[]): Promise<DeleteResponse> {
    return post<DeleteResponse>('/api/delete', { paths })
  },

  // ── 上传 ──────────────────────────────────────────────────────

  /**
   * 小文件直传。
   *
   * ⚠️ 表单字段名必须是 `files`（复数），后端用 getlist("files") 取。
   * ⚠️ 不要手动设置 Content-Type，让浏览器带上 multipart boundary。
   */
  upload(path: string, file: File, signal?: AbortSignal): Promise<UploadResponse> {
    const form = new FormData()
    form.append('path', path)
    form.append('files', file, file.name)
    return request<UploadResponse>('/api/upload', {
      method: 'POST',
      form,
      timeout: 0, // 大文件不设超时
      signal,
    })
  },

  /** 分片上传：初始化会话 */
  uploadInit(
    path: string,
    name: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<UploadInitResponse> {
    return post<UploadInitResponse>('/api/upload/init', { path, name, size }, undefined, {
      timeout: 30_000,
      signal,
    })
  },

  /** 分片上传：传一片 */
  uploadChunk(
    uploadId: string,
    index: number,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<ApiEnvelope> {
    const form = new FormData()
    form.append('upload_id', uploadId)
    form.append('index', String(index))
    form.append('chunk', chunk)
    return request<ApiEnvelope>('/api/upload/chunk', {
      method: 'POST',
      form,
      timeout: 0,
      signal,
    })
  },

  /** 分片上传：合并 */
  uploadComplete(uploadId: string, signal?: AbortSignal): Promise<UploadCompleteResponse> {
    return post<UploadCompleteResponse>('/api/upload/complete', { upload_id: uploadId }, undefined, {
      timeout: 120_000,
      signal,
    })
  },

  /** 分片上传：中止并清理临时分片（危险操作） */
  uploadAbort(uploadId: string): Promise<ApiEnvelope> {
    return post<ApiEnvelope>('/api/upload/abort', { upload_id: uploadId })
  },

  /** 分片上传：查会话状态（续传用） */
  uploadStatus(uploadId: string): Promise<ApiEnvelope> {
    return get<ApiEnvelope>('/api/upload/status', { upload_id: uploadId })
  },

  // ── 下载 ──────────────────────────────────────────────────────

  /**
   * 构造下载链接（用于 <a href> 直接下载）。
   *
   * ⚠️ 只在无法走 Blob 方案时使用。
   *    走 URL 传凭证会被线上网关追加 `:N` 后缀（后端已做剥离容错），
   *    但更稳的做法是用下面的 fetchBlob() —— 它走 X-API-Key 请求头，
   *    凭证不出现在 URL 里（不会被写进日志、浏览器历史、Referer）。
   */
  downloadUrl(path: string): string {
    const params = new URLSearchParams()
    params.set('path', path)
    const key = credentials.getApiKey()
    if (key) params.set('apikey', key)
    else {
      const token = credentials.getToken()
      if (token) params.set('token', token)
    }
    return `${API_BASE}/api/download?${params.toString()}`
  },

  /**
   * 以 Blob 方式下载。
   *
   * 为什么不用 <a href>：那需要把凭证拼进 URL，既会泄露到日志/历史，
   * 又会被网关改写。这里用 fetch + X-API-Key 请求头，干净且可靠。
   *
   * @param path    文件相对路径
   * @param onProgress 进度回调（仅当响应带 Content-Length 时可用）
   * @param signal  用于取消
   */
  async fetchBlob(
    path: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const res = await requestBlob('/api/download', { path }, onProgress, signal)
    return res
  },

  /**
   * 取文件内容为 Object URL，供 <img> / <video> 等原生标签使用。
   *
   * 注意：调用方负责在合适的时机 URL.revokeObjectURL()，
   * 否则会持续占用内存。
   */
  async fetchObjectUrl(path: string, signal?: AbortSignal): Promise<string> {
    const blob = await api.fetchBlob(path, undefined, signal)
    return URL.createObjectURL(blob)
  },

  /**
   * 触发浏览器下载。
   *
   * 先 Blob 拿数据，再用临时的 <a download> 触发保存对话框，
   * 这样文件名能正确带上（URL 直链在跨域时 download 属性可能被忽略）。
   */
  async download(
    path: string,
    filename: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const blob = await api.fetchBlob(path, onProgress, signal)
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally {
      // 给浏览器一点时间发起保存，再释放
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
  },

  // ── 设置 ──────────────────────────────────────────────────────

  getSettings(): Promise<SettingsResponse> {
    return get<SettingsResponse>('/api/settings')
  },

  saveSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
    return post<SettingsResponse>('/api/settings', patch)
  },

  // ── API Key ───────────────────────────────────────────────────

  listApiKeys(): Promise<ApiKeyListResponse> {
    return get<ApiKeyListResponse>('/api/apikeys')
  },

  createApiKey(name: string, ttlDays?: number): Promise<ApiKeyCreateResponse> {
    return post<ApiKeyCreateResponse>('/api/apikeys', {
      name,
      ...(ttlDays !== undefined ? { ttl_days: ttlDays } : {}),
    })
  },

  updateApiKey(
    id: string,
    patch: { name?: string; enabled?: boolean },
  ): Promise<ApiKeyMutateResponse> {
    return request<ApiKeyMutateResponse>(`/api/apikeys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: patch,
    })
  },

  deleteApiKey(id: string): Promise<ApiKeyMutateResponse> {
    return request<ApiKeyMutateResponse>(`/api/apikeys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}
