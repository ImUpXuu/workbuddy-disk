/**
 * 从 DataTransfer 里提取文件。
 *
 * 为什么要单独一个模块：拖拽进来的可能是**文件夹**，
 * `dataTransfer.files` 对文件夹只会给出一个空壳，必须走
 * `webkitGetAsEntry()` 递归遍历才能真正拿到里面的文件。
 *
 * 文件夹会**保留相对路径**（见 CollectedFile.relPath）—— 上传时后端
 * 据此创建对应目录。依据是后端 `/api/upload` 与 `/api/upload/init`
 * 的 `dirmode` 参数：开启后上传接口自身会幂等建目录，因此不需要
 * 前端预调 `/api/mkdir`（那个接口在危险清单里，API Key 模式下可能被拒）。
 */

/** 目录读取器（浏览器原生类型，TS 库里没有） */
interface FsDirReader {
  readEntries(cb: (entries: FsEntry[]) => void, err?: (e: unknown) => void): void
}

/** 浏览器对目录读取的兼容类型（TS 标准库里没有 FileSystemEntry） */
interface FsEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?(cb: (f: File) => void, err?: (e: unknown) => void): void
  createReader?(): FsDirReader
}

/** 从拖拽/选择里收集到的一个待上传文件 */
export interface CollectedFile {
  file: File
  /**
   * 相对「拖入根」的路径，含文件名。例：`'2024/a.jpg'`。
   * 直接拖单个文件时就是文件名本身（`'a.jpg'`）。
   */
  relPath: string
  /** 是否来自目录遍历（而非普通文件选择）—— 决定是否开启 dirmode */
  fromDirectory: boolean
}

/**
 * 从 DataTransfer 收集文件列表，文件夹会被递归展开并保留目录结构。
 *
 * ⚠️ 已知限制：**空文件夹不会产生任何条目**（walk 只收集文件）。
 *    空目录在网盘里价值极低，而支持它需要额外传一份目录清单，
 *    复杂度不值得 —— UI 上会提示用户这一点。
 */
export async function collectFilesFromDataTransfer(dt: DataTransfer): Promise<CollectedFile[]> {
  const items = dt.items ? Array.from(dt.items) : []

  // 拿 entry 需要**同步**取，dataTransfer 在异步之后会失效
  const entries: FsEntry[] = []
  for (const it of items) {
    if (it.kind !== 'file') continue
    const anyItem = it as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }
    const entry = anyItem.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  // 不支持 entry API（或非 Chromium）时退化为普通多文件
  if (!entries.length) {
    return (dt.files ? Array.from(dt.files) : []).map((file) => ({
      file,
      // webkitRelativePath 只在 <input webkitdirectory> 场景有值，拖拽时通常为空
      relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      fromDirectory: false,
    }))
  }

  const out: CollectedFile[] = []
  for (const entry of entries) {
    // 顶层 prefix 为空：直接拖进来的文件 relPath 就是文件名
    await walk(entry, out, '')
  }
  return out
}

/** 递归遍历 entry 树，prefix 累积相对路径 */
async function walk(entry: FsEntry, out: CollectedFile[], prefix: string): Promise<void> {
  if (entry.isFile && entry.file) {
    try {
      const f = await fileOf(entry)
      // ⚠️ 浏览器安全限制：File.name 永远是纯文件名，路径只能自己拼
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push({ file: f, relPath, fromDirectory: prefix !== '' })
    } catch {
      /* 单个文件读取失败不阻断其余 */
    }
    return
  }

  if (entry.isDirectory && entry.createReader) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name
    const children = await readAll(entry.createReader())
    for (const child of children) {
      await walk(child, out, next)
    }
  }
}

function fileOf(entry: FsEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file!(resolve, reject)
  })
}

/**
 * 读空一个目录。
 *
 * ⚠️ readEntries 单次最多只返回 100 条，必须循环读到返回空数组为止，
 *    否则大目录会被静默截断。
 */
function readAll(reader: FsDirReader): Promise<FsEntry[]> {
  return new Promise((resolve) => {
    const acc: FsEntry[] = []
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(acc)
            return
          }
          acc.push(...batch)
          step()
        },
        () => resolve(acc), // 出错就把已读到的返回，不阻断
      )
    }
    step()
  })
}
