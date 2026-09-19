/**
 * 从 DataTransfer 里提取文件。
 *
 * 为什么要单独一个模块：拖拽进来的可能是**文件夹**，
 * `dataTransfer.files` 对文件夹只会给出一个空壳，必须走
 * `webkitGetAsEntry()` 递归遍历才能真正拿到里面的文件。
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

/**
 * 从 DataTransfer 收集文件列表，文件夹会被递归展开。
 *
 * 文件夹展开策略：**扁平化上传到目标目录**，不做自动建目录。
 * 原因是后端 `/api/upload` 与 `/api/upload/init` 的 path 必须是
 * **已存在的目录**，要保留层级就得先调 /api/mkdir 逐个建目录，
 * 而 mkdir 在危险操作清单里（API Key 模式下可能被拒），
 * 失败面太大。扁平化 + 提示用户是更务实的选择。
 */
export async function collectFilesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
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
    return dt.files ? Array.from(dt.files) : []
  }

  const out: File[] = []
  for (const entry of entries) {
    await walk(entry, out)
  }
  return out
}

/** 递归遍历 entry 树 */
async function walk(entry: FsEntry, out: File[]): Promise<void> {
  if (entry.isFile && entry.file) {
    try {
      out.push(await fileOf(entry))
    } catch {
      /* 单个文件读取失败不阻断其余 */
    }
    return
  }

  if (entry.isDirectory && entry.createReader) {
    const children = await readAll(entry.createReader())
    for (const child of children) {
      await walk(child, out)
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
