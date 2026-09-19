/**
 * XHR 上传原语。
 *
 * 为什么不用 fetch：
 *   fetch 没有「上传进度」事件 —— ReadableStream 只能读**响应**体，
 *   读不了**请求**体。要显示上传百分比，唯一的浏览器原生手段是
 *   XMLHttpRequest 的 `xhr.upload.onprogress`。
 *
 * 这个模块只负责「发一个带进度的 multipart 请求并把结果/错误规整好」，
 * 所有编排逻辑（队列、并发、分片、重试）都在 uploadEngine 里。
 *
 * ⚠️ 依赖注入而非直接 import client.ts：
 *    client.ts 要调用本模块的 xhrPostForm，本模块又需要 client.ts 的
 *    buildUrl/buildHeaders/classify/emitUnauthorized —— 直接互相 import
 *    会形成循环依赖。所以这些依赖由 client.ts 在初始化时注入进来
 *    （见 client.ts 底部的 registerXhrDeps 调用）。
 *    同时这也让本模块可以脱离 client.ts 单测。
 */

import { ApiError, type ApiErrorKind } from '../api/client'
import type { ApiEnvelope } from '../types/api'

/** 由 client.ts 注入的依赖，避免循环 import */
interface XhrDeps {
  buildUrl(path: string, query?: Record<string, unknown>): string
  buildHeaders(isJson: boolean, auth: boolean): Headers
  classify(status: number): ApiErrorKind
  emitUnauthorized(): void
}

let deps: XhrDeps | null = null

/** 由 client.ts 在模块初始化时调用一次 */
export function registerXhrDeps(d: XhrDeps): void {
  deps = d
}

export interface XhrPostOptions {
  signal?: AbortSignal
  /**
   * 上行进度。`total` 在 `lengthComputable === false` 时为 0，
   * 调用方需自行处理「拿不到总量」的情况。
   */
  onUploadProgress?(loaded: number, total: number): void
  /** 超时毫秒数；0（默认）表示不超时 —— 大文件上传不能设超时 */
  timeoutMs?: number
}

/**
 * POST 一个 multipart/form-data 请求，带上行进度。
 *
 * ⚠️ 绝不手动设置 Content-Type —— 必须让浏览器自己补
 *    `multipart/form-data; boundary=...`，否则后端无法解析表单。
 */
export function xhrPostForm<T extends ApiEnvelope>(
  path: string,
  form: FormData,
  opts: XhrPostOptions = {},
): Promise<T> {
  const { signal, onUploadProgress, timeoutMs = 0 } = opts

  return new Promise<T>((resolve, reject) => {
    if (!deps) {
      reject(new ApiError('unknown', 'XHR 依赖未初始化'))
      return
    }

    // 已经取消：直接短路，连请求都不用发
    if (signal?.aborted) {
      reject(new ApiError('aborted', '已取消'))
      return
    }

    const xhr = new XMLHttpRequest()
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => xhr.abort()

    // ── 上行进度：这就是用 XHR 的全部理由 ──
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (!onUploadProgress) return
      onUploadProgress(e.loaded, e.lengthComputable ? e.total : 0)
    }

    xhr.onload = () => {
      if (settled) return
      settled = true
      cleanup()

      const status = xhr.status

      // 解析响应体（后端错误也返回 JSON，但网关可能返回 HTML 错误页）
      let payload: ApiEnvelope | undefined
      if (xhr.responseText) {
        try {
          payload = JSON.parse(xhr.responseText) as ApiEnvelope
        } catch {
          /* 非 JSON，交给下面的分支处理 */
        }
      }

      if (status === 204) {
        resolve({ ok: true } as T)
        return
      }

      if (status >= 200 && status < 300) {
        resolve((payload ?? { ok: true }) as T)
        return
      }

      // 失败路径
      const kind: ApiErrorKind = deps!.classify(status)

      if (!payload) {
        // 没有 JSON 体，说明多半是被网关/代理挡下了
        reject(
          new ApiError(
            status === 413 ? 'badrequest' : kind,
            status === 413
              ? '上传数据超出网关请求体上限'
              : `服务返回了非 JSON 响应（HTTP ${status}）`,
            status,
          ),
        )
        return
      }

      // 凭证过期要广播，否则上传中掉登录态会一直静默失败
      if (kind === 'unauthorized') deps!.emitUnauthorized()

      reject(new ApiError(kind, payload.error || `HTTP ${status}`, status, payload))
    }

    xhr.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      reject(
        new ApiError(
          offline ? 'offline' : 'cors',
          offline
            ? '网络不可达，请检查连接'
            : '请求失败：可能是跨域被拦截或连接被重置',
        ),
      )
    }

    xhr.ontimeout = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new ApiError('timeout', '请求超时'))
    }

    xhr.onabort = () => {
      if (settled) return
      settled = true
      cleanup()
      // 区分「用户主动取消」与「超时中止」—— 前者不该报错
      if (timedOut) reject(new ApiError('timeout', '请求超时'))
      else reject(new ApiError('aborted', '已取消'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    if (timeoutMs > 0) {
      xhr.timeout = timeoutMs
      timer = setTimeout(() => {
        timedOut = true
        xhr.abort()
      }, timeoutMs)
    }

    xhr.open('POST', deps.buildUrl(path), true)

    // 只设凭证头；Content-Type 交给浏览器
    deps.buildHeaders(false, true).forEach((value, key) => {
      xhr.setRequestHeader(key, value)
    })

    xhr.send(form)
  })
}
