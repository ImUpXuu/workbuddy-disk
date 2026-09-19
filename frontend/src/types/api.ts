/**
 * 后端契约层 —— 前后端交换数据的唯一共识。
 *
 * 字段一旦与后端对不上，TypeScript 编译就会报错，
 * 不用等到线上才发现。
 */

// ═══════════════════════════════════════════════════════════════════
// 通用信封
// ═══════════════════════════════════════════════════════════════════

/** 所有接口的通用响应形状 */
export interface ApiEnvelope {
  ok: boolean
  error?: string
  /** 收到 401 时后端会给这个标记，前端据此跳登录 */
  auth_required?: boolean
  /** 收到 403 且因危险开关拦截时给这个标记 */
  dangerous_blocked?: boolean
}

// ═══════════════════════════════════════════════════════════════════
// 文件 / 目录
// ═══════════════════════════════════════════════════════════════════

/** 目录项（文件或文件夹） */
export interface Entry {
  name: string
  /** 相对 STORAGE_ROOT 的路径 */
  path: string
  is_dir: boolean
  /** 字节数；目录为 0 */
  size: number
  /** 人类可读大小，如 "1.2 MB" */
  size_h: string
  /** 修改时间戳（秒） */
  mtime: number
  /** 修改时间，格式化后的字符串 */
  mtime_h: string
  /** 扩展名（小写，不含点）；目录为空串 */
  ext?: string
}

/** GET /api/list */
export interface ListResponse extends ApiEnvelope {
  path: string
  items: Entry[]
  /** 单文件大小上限（字节）—— 前端入队时预检，避免传完才被拒 */
  max_file_size?: number
  /** 后端默认分片大小（字节） */
  chunk_size?: number
  /** 超过此大小走分片（字节）—— 前端分派的权威依据 */
  chunk_threshold?: number
}

/** GET /api/stats */
export interface StatsResponse extends ApiEnvelope {
  total_files: number
  total_dirs: number
  /** 占用字节数 */
  total_size: number
  total_size_h: string
}

// ═══════════════════════════════════════════════════════════════════
// 鉴权
// ═══════════════════════════════════════════════════════════════════

/** POST /api/login */
export interface LoginResponse extends ApiEnvelope {
  token: string
  /** 有效期（秒） */
  ttl?: number
  expires_at?: number
}

/**
 * GET /api/whoami
 *
 * 探针接口。无论凭证是否有效都返回 200（除了「传了无效 API Key」这一种情况会 401），
 * 前端靠 `authenticated` 判断，而不是靠状态码 —— 这样能区分
 * 「未登录」与「后端不可用」两种情况。
 */
export interface WhoamiResponse extends ApiEnvelope {
  authenticated: boolean
  kind?: 'session' | 'apikey' | 'none'
  /** 用 API Key 认证时，返回该 Key 的备注名 */
  key_name?: string | null
}

// ═══════════════════════════════════════════════════════════════════
// 设置
// ═══════════════════════════════════════════════════════════════════

export interface Settings {
  /** 多文件并发上传数，1~10 */
  upload_concurrency: number
  /** 是否允许 API Key 执行删除 / 重命名 / 新建 / 中止上传 */
  allow_dangerous: boolean
  /** 新建 Key 的默认有效期（天），0 表示永不过期 */
  apikey_ttl_days: number
}

/** GET /api/settings —— 除设置本身外还带运行信息 */
export interface SettingsResponse extends ApiEnvelope {
  settings: Settings
  runtime?: {
    version?: string
    storage_root?: string
    uptime_h?: string
    chunk_size_h?: string
    max_file_size_h?: string
  }
}

// ═══════════════════════════════════════════════════════════════════
// API Key
// ═══════════════════════════════════════════════════════════════════

/** Key 的公开视图（不含明文） */
export interface ApiKeyItem {
  id: string
  name: string
  /** 前缀，形如 ndk_EKhFTRnB，用于列表里辨认 */
  prefix: string
  enabled: boolean
  expired: boolean
  scope: string
  created_at: number
  created_h: string
  /** 0 表示永不过期 */
  expires_at: number
  expires_h: string
  last_used_at: number
  last_used_h: string
  use_count: number
}

/** GET /api/apikeys */
export interface ApiKeyListResponse extends ApiEnvelope {
  items: ApiKeyItem[]
}

/**
 * POST /api/apikeys
 *
 * ⚠️ `key` 是**明文字符串**（如 `ndk_xxxx_yyyy`），不是对象。
 *    只在创建时返回这一次，之后服务端只有哈希，无法找回。
 */
export interface ApiKeyCreateResponse extends ApiEnvelope {
  key: string
  item: ApiKeyItem
  warning?: string
}

/** PATCH / DELETE /api/apikeys/<id> */
export interface ApiKeyMutateResponse extends ApiEnvelope {
  item?: ApiKeyItem
  id?: string
}

// ═══════════════════════════════════════════════════════════════════
// 上传
// ═══════════════════════════════════════════════════════════════════

/** POST /api/upload 的单项结果 */
export interface UploadResultItem {
  name: string
  ok: boolean
  size?: number
  size_h?: string
  error?: string
}

/** POST /api/upload —— 小文件直传（表单字段名是 files，复数） */
export interface UploadResponse extends ApiEnvelope {
  results: UploadResultItem[]
  uploaded: number
  failed: number
}

/** POST /api/upload/init */
export interface UploadInitResponse extends ApiEnvelope {
  upload_id: string
  /** 分片大小（字节） */
  chunk_size: number
  total_chunks: number
  name: string
}

/** POST /api/upload/chunk */
export interface UploadChunkResponse extends ApiEnvelope {
  index: number
  received: number
  total: number
}

/** POST /api/upload/complete */
export interface UploadCompleteResponse extends ApiEnvelope {
  name: string
  path: string
  size: number
  size_h: string
}

/** GET /api/upload/status */
export interface UploadStatusResponse extends ApiEnvelope {
  upload_id: string
  /** 文件名 */
  name?: string
  total_chunks: number
  /** 已收到的分片序号（后端只回这一份，缺片由前端自己算差集） */
  received: number[]
  /** 文件总字节数 */
  size?: number
}

// ═══════════════════════════════════════════════════════════════════
// 写操作
// ═══════════════════════════════════════════════════════════════════

/** POST /api/mkdir */
export interface MkdirResponse extends ApiEnvelope {
  name: string
}

/** POST /api/rename */
export interface RenameResponse extends ApiEnvelope {
  new_path: string
}

/** POST /api/delete */
export interface DeleteResponse extends ApiEnvelope {
  deleted?: string[]
  failed?: { path: string; error: string }[]
}

// ═══════════════════════════════════════════════════════════════════
// 上传任务（前端本地模型，不来自后端）
// ═══════════════════════════════════════════════════════════════════

export type TaskStatus =
  | 'queued'    // 排队中，等待调度
  | 'uploading' // 上传中
  | 'merging'   // 分片合并中
  | 'done'      // 完成
  | 'failed'    // 失败
  | 'canceled'  // 已取消

export interface UploadTask {
  /** 前端生成的唯一 id */
  id: string
  file: File
  /** 目标目录（相对路径） */
  targetPath: string
  name: string
  size: number
  status: TaskStatus
  /** 0~1 */
  progress: number
  /** 已上传字节 */
  loaded: number
  /** 分片模式下的会话 id */
  uploadId?: string
  /** 分片总数；直传为 1 */
  totalChunks: number
  /** 已成功上传的分片数 */
  doneChunks: number
  error?: string
  startedAt?: number
  finishedAt?: number
  /** 字节/秒 */
  speed?: number
}
