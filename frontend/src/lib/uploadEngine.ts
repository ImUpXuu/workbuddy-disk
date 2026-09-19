/**
 * 上传引擎。
 *
 * 设计要点
 * ────────
 * 1. **零 React 依赖**：模块级单例，组件挂载/卸载不影响上传进度。
 *    切目录、开关弹窗导致的重渲染不会打断上传 —— 这是把状态放在
 *    组件里做不到的。React 侧通过 useSyncExternalStore 订阅（见 hooks/useUpload.ts）。
 *
 * 2. **K-worker 轮询调度，而不是 Promise.all**：
 *    一次性发起 1000 个请求会被浏览器按 host 限流（Chrome 约 6 条），
 *    结果是前几条疯狂抢带宽、其余排队等连接、进度条集体卡住，
 *    而且无法取消。所以固定维持 K 个常驻 worker 从队列拉取任务。
 *
 * 3. **进度节流**：xhr.upload.onprogress 触发频率可达每毫秒多次，
 *    每次都触发 React 重渲染会直接卡死页面。高频进度合并到 100ms，
 *    状态机变迁（开始/完成/失败）立即广播，保证操作响应感。
 *
 * 4. **分片大小取 8MB 而非后端的 48MB**：
 *    线上网关请求体上限实测约 50MB，48MB 分片 + multipart 边界 +
 *    表单字段贴得太紧，随时可能 413。后端只在 chunk_size > CHUNK_SIZE
 *    时才夹回上限，所以传更小的值是被尊重的。
 */

import { ApiError, api, onUnauthorized } from '../api/client'
import type { TaskStatus, UploadTask } from '../types/api'
import { errorText } from './utils'

// ═══════════════════════════════════════════════════════════════════
// 常量与纯函数（可单测）
// ═══════════════════════════════════════════════════════════════════

/**
 * 默认分片大小 8MB。
 *
 * 为什么不直接用后端的 48MB：网关请求体上限约 50MB，
 * 48MB 分片再加上 multipart 边界、upload_id/index 等表单字段，
 * 余量只剩 1~2MB，网络稍有波动就会 413。
 * 8MB 的代价是大文件分片数变多，但每片都稳。
 */
export const DEFAULT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024

/** 网关请求体上限（实测约 50MB），用于计算安全的分片大小 */
const GATEWAY_BODY_LIMIT = 50 * 1024 * 1024
/** multipart 边界 + 其他表单字段的预留余量 */
const MULTIPART_OVERHEAD = 2 * 1024 * 1024

/**
 * 计算实际使用的分片大小：不超过配置值，也不超过网关能接受的上限。
 */
export function chooseChunkSize(configured: number): number {
  const cap = GATEWAY_BODY_LIMIT - MULTIPART_OVERHEAD
  return Math.max(1 * 1024 * 1024, Math.min(configured, cap))
}

/**
 * 判断某文件是否走分片上传。
 *
 * ⚠️ 0 字节文件必须走**直传**：
 *    `/api/upload/init` 对 `size <= 0` 直接返回 400（校验的是 size 有效性），
 *    而 `/api/upload` 直传能正常保存空文件。
 *    写成 `size > threshold` 恰好让 0 走直传，但这是**隐式**的 ——
 *    加个显式分支，避免以后有人把这里改成 `>=` 就悄悄坏掉。
 */
export function shouldUseChunked(size: number, threshold: number): boolean {
  if (size <= 0) return false // 空文件只能直传，见上方说明
  return size > threshold
}

/**
 * 截取第 index 片。
 *
 * 用 `File.slice()` 而不是把文件读进内存再切 —— slice 返回的是
 * 指向磁盘文件的视图（零拷贝），这是能处理 2GiB 文件的前提。
 */
export function sliceChunk(file: File, index: number, chunkSize: number): Blob {
  const start = index * chunkSize
  const end = Math.min(start + chunkSize, file.size)
  return file.slice(start, end)
}

/** 第 index 片的实际字节数（最后一片可能不满） */
function chunkByteLength(index: number, chunkSize: number, totalSize: number): number {
  const start = index * chunkSize
  return Math.max(0, Math.min(chunkSize, totalSize - start))
}

// ═══════════════════════════════════════════════════════════════════
// 对外类型
// ═══════════════════════════════════════════════════════════════════

export interface EngineConfig {
  /** 同时上传的文件数。来自后端 settings.upload_concurrency（1~10） */
  concurrency: number
  /** 超过此大小走分片。来自 ListResponse.chunk_threshold */
  chunkThreshold: number
  /** 分片大小。默认 8MB，见 DEFAULT_UPLOAD_CHUNK_SIZE */
  chunkSize: number
  /** 单文件上限。来自 ListResponse.max_file_size */
  maxFileSize: number
}

const DEFAULT_CONFIG: EngineConfig = {
  concurrency: 3,
  chunkThreshold: 48 * 1024 * 1024,
  chunkSize: DEFAULT_UPLOAD_CHUNK_SIZE,
  maxFileSize: 2 * 1024 * 1024 * 1024,
}

/** 任务快照（去掉 Map/Set/File 等内部字段，只留可渲染数据） */
export interface TaskView {
  id: string
  name: string
  size: number
  targetPath: string
  status: TaskStatus
  /** 0~1 */
  progress: number
  loaded: number
  speed?: number
  error?: string
  /** 分片模式下的分片进度 */
  totalChunks: number
  doneChunks: number
  mode: 'direct' | 'chunked' | 'pending'
  /** 上传完成时后端实际落盘的文件名（可能因重名被改名） */
  finalName?: string
}

export interface UploadSnapshot {
  tasks: readonly TaskView[]
  total: number
  doneCount: number
  failedCount: number
  canceledCount: number
  /** 排队 + 上传中 + 合并中的数量 */
  activeCount: number
  /** 按字节加权的总进度（0~1） */
  overallProgress: number
  /** 所有活跃任务的合计速度（字节/秒） */
  totalSpeed: number
  /** 活跃任务的剩余字节，用于估算 ETA */
  remainBytes: number
}

/** 任务完成/改名的通知（供列表刷新等副作用订阅） */
export interface UploadEvent {
  task: TaskView
  /** 是否发生了重名自动改名 */
  renamed: boolean
}

type DoneListener = (e: UploadEvent) => void
type WarningListener = (message: string) => void

/** 引擎内部任务：在 TaskView 基础上带运行时字段 */
interface TaskInternal extends TaskView {
  file: File
  /** Map<分片序号, 该片已上传字节>；与 chunkDone 互斥 */
  chunkLoaded: Map<number, number>
  /** 已完成的分片序号 */
  chunkDone: Set<number>
  /** 后端确认的分片大小（以后端返回为准，可能与我们请求的不同） */
  serverChunkSize: number
  /** 分片会话 id */
  uploadId?: string
  ac: AbortController | null
  /** 已重试次数 */
  attempts: number
  /** 是否需要在开工前向后端同步已收分片（重试用） */
  needResync: boolean
  /** 速度采样 */
  sampleAt: number
  sampleLoaded: number
  startedAt?: number
  finishedAt?: number
}

// ═══════════════════════════════════════════════════════════════════
// 引擎
// ═══════════════════════════════════════════════════════════════════

const EMIT_THROTTLE_MS = 100

export class UploadEngine {
  private cfg: EngineConfig = { ...DEFAULT_CONFIG }
  private tasks = new Map<string, TaskInternal>()
  private queue: string[] = []
  /** 当前在跑的 worker 数 —— 不变量：workerCount <= cfg.concurrency */
  private workerCount = 0

  private listeners = new Set<() => void>()
  private snapshot: UploadSnapshot | null = null

  private doneListeners = new Set<DoneListener>()
  private warnListeners = new Set<WarningListener>()

  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private throttlePending = false

  constructor() {
    // 凭证失效时立刻停掉所有上传 —— 否则会一直发请求、一直 401
    onUnauthorized(() => void this.cancelAll())
  }

  // ── 订阅（useSyncExternalStore 契约）──────────────────────────

  /** 注意：必须是稳定引用，否则 useSyncExternalStore 会反复订阅 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 返回当前快照。引用稳定性是 useSyncExternalStore 的硬要求 ——
   * 状态没变时必须返回同一个对象，否则会无限重渲染。
   */
  getSnapshot = (): UploadSnapshot => {
    if (this.snapshot) return this.snapshot
    this.snapshot = this.buildSnapshot()
    return this.snapshot
  }

  /**
   * 当前在跑的 worker 数。
   *
   * 只为开发期自省暴露：`workerCount <= cfg.concurrency` 是引擎的
   * 核心不变量，破了就意味着并发限流失效。这个值在闭包里，
   * 出问题时从外部看不到，所以开个只读口子。
   */
  debugWorkerCount(): number {
    return this.workerCount
  }

  /** 订阅任务完成事件。返回取消订阅函数（设计成订阅数组而非单槽回调） */
  onTaskDone(fn: DoneListener): () => void {
    this.doneListeners.add(fn)
    return () => {
      this.doneListeners.delete(fn)
    }
  }

  /** 订阅非致命警告（例如后端拒绝清理临时分片） */
  onWarning(fn: WarningListener): () => void {
    this.warnListeners.add(fn)
    return () => {
      this.warnListeners.delete(fn)
    }
  }

  private buildSnapshot(): UploadSnapshot {
    const tasks: TaskView[] = []
    let doneCount = 0
    let failedCount = 0
    let canceledCount = 0
    let activeCount = 0
    let weightedLoaded = 0
    let weightedTotal = 0
    let totalSpeed = 0
    let remainBytes = 0

    for (const t of this.tasks.values()) {
      tasks.push(toView(t))
      if (t.status === 'done') {
        doneCount++
        weightedLoaded += t.size
        weightedTotal += t.size
      } else if (t.status === 'failed') {
        failedCount++
        weightedTotal += t.size
      } else if (t.status === 'canceled') {
        canceledCount++
        weightedTotal += t.size
      } else {
        // 排队中算作活跃，但还没开始传，不贡献速度
        activeCount++
        weightedLoaded += t.loaded
        weightedTotal += t.size
        if (t.status === 'uploading' || t.status === 'merging') {
          totalSpeed += t.speed || 0
          remainBytes += Math.max(0, t.size - t.loaded)
        }
      }
    }

    return {
      tasks,
      total: tasks.length,
      doneCount,
      failedCount,
      canceledCount,
      activeCount,
      overallProgress: weightedTotal > 0 ? Math.min(1, weightedLoaded / weightedTotal) : 0,
      totalSpeed,
      remainBytes,
    }
  }

  // ── 广播 ────────────────────────────────────────────────────

  /** 立即广播。用于状态机变迁，保证操作有即时反馈 */
  private emit(): void {
    this.snapshot = null // 作废缓存，下次 getSnapshot 重建
    this.listeners.forEach((fn) => {
      try {
        fn()
      } catch {
        /* 订阅者出错不影响引擎 */
      }
    })
  }

  /** 节流广播。用于高频进度回调，避免每毫秒触发一次 React 重渲染 */
  private emitThrottled(): void {
    this.throttlePending = true
    if (this.throttleTimer !== null) return
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      if (this.throttlePending) {
        this.throttlePending = false
        this.emit()
      }
    }, EMIT_THROTTLE_MS)
  }

  // ── 配置 ────────────────────────────────────────────────────

  /** 幂等：可重复调用，用于从后端拉回配置后注入 */
  configure(patch: Partial<EngineConfig>): void {
    const next: EngineConfig = { ...this.cfg }
    if (typeof patch.concurrency === 'number') {
      next.concurrency = Math.max(1, Math.min(10, Math.floor(patch.concurrency)))
    }
    if (typeof patch.chunkThreshold === 'number' && patch.chunkThreshold > 0) {
      next.chunkThreshold = patch.chunkThreshold
    }
    if (typeof patch.chunkSize === 'number' && patch.chunkSize > 0) {
      next.chunkSize = patch.chunkSize
    }
    if (typeof patch.maxFileSize === 'number' && patch.maxFileSize > 0) {
      next.maxFileSize = patch.maxFileSize
    }
    this.cfg = next
    // 并发数调大后可能有空槽位，立刻补位
    this.pump()
  }

  getConfig(): EngineConfig {
    return { ...this.cfg }
  }

  // ── 入队 ────────────────────────────────────────────────────

  /**
   * 把文件加入上传队列。
   *
   * @param targetPath 目标目录。**在此刻快照**，之后用户切换目录不影响本任务。
   * @returns 新建任务的 id 列表
   */
  addFiles(files: File[], targetPath: string): string[] {
    const ids: string[] = []

    for (const file of files) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const task: TaskInternal = {
        id,
        file,
        name: file.name,
        size: file.size,
        targetPath,
        status: 'queued',
        progress: 0,
        loaded: 0,
        totalChunks: 1,
        doneChunks: 0,
        mode: 'pending',
        chunkLoaded: new Map(),
        chunkDone: new Set(),
        serverChunkSize: 0,
        ac: null,
        attempts: 0,
        needResync: false,
        sampleAt: Date.now(),
        sampleLoaded: 0,
      }

      // 超限文件直接判失败，不发请求 —— 避免传完 256 片才在合并阶段被拒
      if (task.size > this.cfg.maxFileSize) {
        task.status = 'failed'
        task.error = `文件过大，单文件上限 ${humanSizeShort(this.cfg.maxFileSize)}`
        task.finishedAt = Date.now()
      }

      this.tasks.set(id, task)
      if (task.status === 'queued') {
        this.queue.push(id)
        ids.push(id)
      } else {
        ids.push(id)
      }
    }

    this.emit()
    this.pump()
    return ids
  }

  // ── 调度 ────────────────────────────────────────────────────

  /**
   * 维持 K 个 worker 直到队列清空。
   *
   * 每次 worker 结束都会回调到这里「补位」，这样始终有恰好
   * cfg.concurrency 个任务在跑，而不是一次性全部发起。
   */
  private pump(): void {
    const limit = this.cfg.concurrency

    while (this.workerCount < limit && this.queue.length > 0) {
      const id = this.queue.shift()!
      const task = this.tasks.get(id)

      // 任务可能已被取消/移除；状态守卫保证不浪费槽位
      if (!task || task.status !== 'queued') continue

      this.workerCount++
      const p = this.runTask(task)
        // runTask 内部已收敛所有错误，这里只兜底防 unhandledrejection
        .catch(() => undefined)
        .finally(() => {
          this.workerCount--
          this.pump() // 递归补位
        })
      void p
    }
  }

  /** 是否有未完成的任务 —— FileBrowser 的 uploading 标志 */
  hasActive(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status === 'queued' || t.status === 'uploading' || t.status === 'merging') {
        return true
      }
    }
    return false
  }

  // ── 单个任务执行 ────────────────────────────────────────────

  private async runTask(task: TaskInternal): Promise<void> {
    if (task.status !== 'queued') return

    task.status = 'uploading'
    task.startedAt = Date.now()
    task.error = undefined
    task.sampleAt = Date.now()
    task.sampleLoaded = 0
    this.emit()

    const ac = new AbortController()
    task.ac = ac

    try {
      if (task.attempts > 0) task.needResync = task.mode === 'chunked'

      if (shouldUseChunked(task.size, this.cfg.chunkThreshold)) {
        task.mode = 'chunked'
        await this.uploadChunked(task, ac.signal)
      } else {
        task.mode = 'direct'
        await this.uploadDirect(task, ac.signal)
      }

      task.status = 'done'
      task.progress = 1
      task.loaded = task.size
      task.speed = undefined
      task.finishedAt = Date.now()

      const view = toView(task)
      const renamed = !!task.finalName && task.finalName !== task.name
      this.emit()
      this.doneListeners.forEach((fn) => {
        try {
          fn({ task: view, renamed })
        } catch {
          /* 订阅者出错不影响引擎 */
        }
      })
    } catch (err) {
      // 用户主动取消不算错误
      if (err instanceof ApiError && err.kind === 'aborted') {
        task.status = 'canceled'
      } else {
        task.status = 'failed'
        task.error = err instanceof ApiError ? err.friendly : errorText(err)
      }
      task.speed = undefined
      task.finishedAt = Date.now()
    } finally {
      task.ac = null
      this.emit()
    }
  }

  /** 直传（小文件 / 空文件） */
  private async uploadDirect(task: TaskInternal, signal: AbortSignal): Promise<void> {
    const res = await api.uploadWithProgress(
      task.targetPath,
      task.file,
      (loaded) => {
        task.loaded = Math.min(task.size, loaded)
        task.progress = task.size > 0 ? task.loaded / task.size : 0
        this.tickSpeed(task)
        this.emitThrottled()
      },
      signal,
    )

    // 后端重名时不覆盖，会自动改名 —— 记下真实落盘名
    const item = res.results?.find((r) => r.ok)
    if (item?.name) task.finalName = item.name
    else if (res.results?.length && !item) {
      const bad = res.results.find((r) => !r.ok)
      throw new ApiError('badrequest', bad?.error || '上传失败')
    }
  }

  /** 分片上传 */
  private async uploadChunked(task: TaskInternal, signal: AbortSignal): Promise<void> {
    // ① 初始化会话
    if (!task.uploadId) {
      const wanted = chooseChunkSize(this.cfg.chunkSize)
      const init = await api.uploadInit(
        task.targetPath,
        task.name,
        task.size,
        wanted,
        signal,
      )
      task.uploadId = init.upload_id
      // ⚠️ 以后端返回为准 —— 后端可能夹取了 chunk_size
      task.serverChunkSize = init.chunk_size
      task.totalChunks = init.total_chunks
    }
    const cs = task.serverChunkSize

    // ② 重试时同步后端已收分片，跳过它们
    if (task.needResync) {
      task.needResync = false
      try {
        const st = await api.uploadStatus(task.uploadId)
        const received = (st as { received?: number[] }).received || []
        for (const i of received) task.chunkDone.add(i)
        this.recomputeProgress(task)
      } catch (err) {
        // 会话已过期（后端按 TTL 清理）：清空重来
        if (err instanceof ApiError && (err.kind === 'notfound' || err.kind === 'badrequest')) {
          task.uploadId = undefined
          task.chunkDone.clear()
          task.chunkLoaded.clear()
          task.totalChunks = 1
          task.loaded = 0
          task.progress = 0
          this.emit()
          return this.uploadChunked(task, signal)
        }
        throw err
      }
    }

    // ③ 逐片上传。片内串行 —— 文件间并发已由调度器负责，
    //    单文件内部再并发只会互相抢带宽、让 ETA 抖动
    for (let i = 0; i < task.totalChunks; i++) {
      if (signal.aborted) throw new ApiError('aborted', '已取消')
      if (task.chunkDone.has(i)) continue

      await api.uploadChunkWithProgress(
        task.uploadId,
        i,
        sliceChunk(task.file, i, cs),
        (loaded) => {
          task.chunkLoaded.set(i, loaded)
          this.recomputeProgress(task)
          this.tickSpeed(task)
          this.emitThrottled()
        },
        signal,
      )

      // 该片已确认落盘：从「在传」移到「已完成」（两者互斥，不会双计）
      task.chunkLoaded.delete(i)
      task.chunkDone.add(i)
      this.recomputeProgress(task)
      this.emit()
    }

    // ④ 合并
    task.status = 'merging'
    this.emit()
    const done = await api.uploadComplete(task.uploadId, signal)
    const finalName = (done as { name?: string }).name
    if (finalName) task.finalName = finalName
    // 合并成功后后端已清理会话，本地不再需要 abort
    task.uploadId = undefined
  }

  /**
   * 重算总进度。
   *
   * 不变量：loaded = Σ(已完成分片字节) + Σ(在传分片上行字节)
   * 最后一片可能不满，必须按实际字节数算，否则进度会超过 100%。
   */
  private recomputeProgress(task: TaskInternal): void {
    const cs = task.serverChunkSize || this.cfg.chunkSize
    let confirmed = 0
    for (const i of task.chunkDone) {
      confirmed += chunkByteLength(i, cs, task.size)
    }
    let inflight = 0
    for (const bytes of task.chunkLoaded.values()) {
      inflight += bytes
    }
    // 夹紧到总大小，防重复上报导致进度溢出
    task.loaded = Math.min(task.size, confirmed + inflight)
    task.progress = task.size > 0 ? task.loaded / task.size : 0
    task.doneChunks = task.chunkDone.size
  }

  /** 滑动窗口测速（指数平滑，避免数字乱跳） */
  private tickSpeed(task: TaskInternal): void {
    const now = Date.now()
    const dt = now - task.sampleAt
    if (dt < 500) return
    const dBytes = task.loaded - task.sampleLoaded
    if (dBytes < 0) {
      // 进度回退（重传），重置采样点
      task.sampleAt = now
      task.sampleLoaded = task.loaded
      return
    }
    const instant = (dBytes / dt) * 1000
    task.speed = task.speed ? task.speed * 0.6 + instant * 0.4 : instant
    task.sampleAt = now
    task.sampleLoaded = task.loaded
  }

  // ── 任务操作 ────────────────────────────────────────────────

  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (isTerminal(task.status)) return

    const wasRunning = task.status === 'uploading' || task.status === 'merging'
    const uploadId = task.uploadId

    // ① 本地立刻终态化 —— UI 不等后端确认
    task.status = 'canceled'
    task.finishedAt = Date.now()
    task.error = undefined
    task.speed = undefined

    // ② 若还在队列里，剔除掉（否则会白占一个 worker 槽位）
    const qi = this.queue.indexOf(id)
    if (qi >= 0) this.queue.splice(qi, 1)

    // ③ 断掉在飞的传输。这会让 XHR 抛 aborted，
    //    runTask 捕获后置 canceled，worker 的 finally 照常补位
    task.ac?.abort()
    task.ac = null

    this.emit()

    // ④ 分片模式：尽力清理后端临时分片。
    //    API Key + allow_dangerous=false 时后端会 403，这不是错误 ——
    //    临时目录由后端按 TTL 自动清理。绝不能因此把状态改回 failed。
    if (wasRunning && uploadId) {
      try {
        await api.uploadAbort(uploadId)
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'forbidden') {
          this.warn('服务端未清理临时分片，将在超时后自动回收')
        }
        /* 其他错误同样忽略：本地状态已是 canceled，不影响用户 */
      }
    }
  }

  async cancelAll(): Promise<void> {
    this.queue = []
    const active = [...this.tasks.values()].filter((t) => !isTerminal(t.status))
    // allSettled 而非 all：单个取消失败不能阻断其余
    await Promise.allSettled(active.map((t) => this.cancel(t.id)))
  }

  /** 重试失败/已取消的任务 */
  async retry(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status !== 'failed' && task.status !== 'canceled') return

    // 超限文件重试也没用，直接告知
    if (task.size > this.cfg.maxFileSize) {
      task.error = `文件过大，单文件上限 ${humanSizeShort(this.cfg.maxFileSize)}`
      this.emit()
      return
    }

    task.attempts++
    task.status = 'queued'
    task.error = undefined
    task.speed = undefined
    task.startedAt = undefined
    task.finishedAt = undefined
    task.sampleAt = Date.now()
    task.sampleLoaded = task.loaded

    // 分片模式：开工前向后端同步已收分片，跳过已传的
    task.needResync = task.mode === 'chunked' && !!task.uploadId

    if (!this.queue.includes(id)) this.queue.push(id)
    this.emit()
    this.pump()
  }

  /** 清掉所有已终结的任务记录 */
  clearFinished(): void {
    for (const [id, t] of [...this.tasks.entries()]) {
      if (isTerminal(t.status)) this.tasks.delete(id)
    }
    this.emit()
  }

  /** 移除单个任务（仅终态可移除） */
  remove(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || !isTerminal(task.status)) return false
    this.tasks.delete(id)
    this.emit()
    return true
  }

  private warn(message: string): void {
    this.warnListeners.forEach((fn) => {
      try {
        fn(message)
      } catch {
        /* 忽略 */
      }
    })
  }
}

// ═══════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════

function isTerminal(s: TaskStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'canceled'
}

/** 内部任务 → 可渲染快照（剥掉 File/Map/Set 等） */
function toView(t: TaskInternal): TaskView {
  return {
    id: t.id,
    name: t.finalName || t.name,
    size: t.size,
    targetPath: t.targetPath,
    status: t.status,
    progress: t.progress,
    loaded: t.loaded,
    speed: t.speed,
    error: t.error,
    totalChunks: t.totalChunks,
    doneChunks: t.doneChunks,
    mode: t.mode,
    finalName: t.finalName,
  }
}

/** 简短的大小文案，用于错误消息（不引 utils 避免循环依赖） */
function humanSizeShort(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** 全应用唯一实例 */
export const uploadEngine = new UploadEngine()

// ── 开发期自省入口 ────────────────────────────────────────────
//
// 把引擎挂到 window 上，方便在控制台里查「现在到底几个 worker 在跑」。
// 并发上限是引擎的核心不变量，但它在闭包里，线上出问题时没法看。
// 只在 dev 构建注入，生产构建不挂（避免污染全局）。
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__uploadEngine = {
    snapshot: () => uploadEngine.getSnapshot(),
    config: () => uploadEngine.getConfig(),
    /** 当前在跑的 worker 数 —— 必须始终 <= config().concurrency */
    workerCount: () => uploadEngine.debugWorkerCount(),
  }
}

export type { UploadTask }
