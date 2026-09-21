/**
 * 上传引擎的 React 桥接。
 *
 * 引擎是模块级单例（见 lib/uploadEngine.ts），这里只负责订阅。
 * 用 useSyncExternalStore 而不是 Context，是因为：
 *   - Context 的 value 一变，所有消费者都要重渲染。上传进度每秒变 10 次，
 *     整个文件列表会跟着疯狂重渲染。
 *   - useSyncExternalStore 让每个 hook 只订阅自己关心的切片。
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { uploadEngine, type UploadSnapshot } from '../lib/uploadEngine'

/**
 * 订阅完整快照 —— 上传面板用。
 * 注意：会让调用方随每次进度更新重渲染，只适合面板这类小范围组件。
 */
export function useUpload(): UploadSnapshot {
  return useSyncExternalStore(
    uploadEngine.subscribe,
    uploadEngine.getSnapshot,
    uploadEngine.getSnapshot,
  )
}

/**
 * 只订阅「是否有上传在跑」。
 *
 * 返回的是原始 boolean，useSyncExternalStore 用 Object.is 比较 ——
 * 只要这个布尔值不变，调用方**完全不会**因进度变化重渲染。
 * 文件列表用这个，避免整个列表跟着进度条重绘。
 */
export function useIsUploading(): boolean {
  return useSyncExternalStore(
    uploadEngine.subscribe,
    () => uploadEngine.hasActive(),
    () => false,
  )
}

/**
 * 上传中关闭/刷新页面时给出确认提示，防误关。
 *
 * 本期不做跨刷新的断点续传，所以刷新就等于丢失进度 ——
 * 拦一下比事后懊悔好。
 */
export function useUploadUnloadGuard(): void {
  const uploading = useIsUploading()
  useEffect(() => {
    if (!uploading) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // 部分浏览器仍要求设置 returnValue 才会弹确认
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [uploading])
}

/**
 * 引擎操作。用 useMemo 保持引用稳定，方便直接放进依赖数组。
 */
export function useUploadActions() {
  return useMemo(
    () => ({
      addFiles: (files: File[], targetPath: string) =>
        uploadEngine.addFiles(files, targetPath),
      /** 带相对路径的文件（文件夹拖拽/选择）—— 保留目录结构 */
      addCollected: (items: Parameters<typeof uploadEngine.addCollected>[0], targetPath: string) =>
        uploadEngine.addCollected(items, targetPath),
      cancel: (id: string) => uploadEngine.cancel(id),
      retry: (id: string) => uploadEngine.retry(id),
      cancelAll: () => uploadEngine.cancelAll(),
      clearFinished: () => uploadEngine.clearFinished(),
      remove: (id: string) => uploadEngine.remove(id),
      configure: (patch: Parameters<typeof uploadEngine.configure>[0]) =>
        uploadEngine.configure(patch),
      onTaskDone: (fn: Parameters<typeof uploadEngine.onTaskDone>[0]) =>
        uploadEngine.onTaskDone(fn),
      onWarning: (fn: Parameters<typeof uploadEngine.onWarning>[0]) =>
        uploadEngine.onWarning(fn),
    }),
    [],
  )
}

export { uploadEngine }
