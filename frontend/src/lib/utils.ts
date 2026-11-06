/**
 * 通用工具：格式化、路径处理、文件类型判断。
 */

// ═══════════════════════════════════════════════════════════════════
// 格式化
// ═══════════════════════════════════════════════════════════════════

/** 字节数 → 人类可读。与后端 human_size 口径保持一致（1024 进制）。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // 小于 10 保留一位小数，否则取整，避免 "1023.7 MB" 这种噪音
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** 字节/秒 → 速度文本 */
export function humanSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
  return `${humanSize(bytesPerSec)}/s`
}

/** 秒数 → 中文可读时长 */
export function humanDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)} 秒`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/** 剩余时间估算 */
export function humanEta(remainBytes: number, speed: number): string {
  if (!speed || speed <= 0) return '—'
  return humanDuration(remainBytes / speed)
}

/** 时间戳（秒）→ 相对时间 */
export function humanDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000

  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`

  const y = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')

  return y === now.getFullYear()
    ? `${mm}-${dd} ${hh}:${mi}`
    : `${y}-${mm}-${dd}`
}

/** 时间戳（秒）→ 完整时间 */
export function fullDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ═══════════════════════════════════════════════════════════════════
// 路径
// ═══════════════════════════════════════════════════════════════════

/** 拼接路径，处理空段与多余斜杠 */
export function joinPath(...parts: (string | undefined | null)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** 取父目录 */
export function parentPath(path: string): string {
  const segs = splitPath(path)
  segs.pop()
  return segs.join('/')
}

/** 拆成路径段 */
export function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** 生成面包屑：[{name, path}]，含虚拟的「根」 */
export function buildBreadcrumb(path: string): { name: string; path: string }[] {
  const segs = splitPath(path)
  const out: { name: string; path: string }[] = []
  let acc = ''
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s
    out.push({ name: s, path: acc })
  }
  return out
}

/** 取文件名（末段） */
export function baseName(path: string): string {
  const segs = splitPath(path)
  return segs[segs.length - 1] || ''
}

// ═══════════════════════════════════════════════════════════════════
// 文件类型
// ═══════════════════════════════════════════════════════════════════

/** 取小写扩展名（不含点） */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

export type FileKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'document'
  | 'code'
  | 'apk'
  | 'font'
  | 'file'

const EXT_MAP: Record<string, FileKind> = {
  // 图片
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  bmp: 'image', svg: 'image', ico: 'image', avif: 'image', heic: 'image', tiff: 'image',
  // 视频
  // 注：`ts` 既是 MPEG-TS 视频流也是 TypeScript 源码，后者更常见，故归入代码类
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video',
  flv: 'video', wmv: 'video', m4v: 'video', rmvb: 'video', mpg: 'video', mpeg: 'video',
  // 音频
  mp3: 'audio', flac: 'audio', wav: 'audio', aac: 'audio', ogg: 'audio',
  m4a: 'audio', wma: 'audio', ape: 'audio', opus: 'audio',
  // 压缩包
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  bz2: 'archive', xz: 'archive', tgz: 'archive', iso: 'archive',
  // 文档
  pdf: 'document', doc: 'document', docx: 'document', xls: 'document',
  xlsx: 'document', ppt: 'document', pptx: 'document', txt: 'document',
  md: 'document', rtf: 'document', csv: 'document', odt: 'document',
  epub: 'document', mobi: 'document',
  // 代码
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', json: 'code', html: 'code',
  css: 'code', py: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code',
  go: 'code', rs: 'code', rb: 'code', php: 'code', sh: 'code', yml: 'code',
  yaml: 'code', xml: 'code', sql: 'code', toml: 'code', ini: 'code',
  // 安装包
  apk: 'apk', exe: 'apk', dmg: 'apk', deb: 'apk', rpm: 'apk', msi: 'apk',
  // 字体
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
}

export function kindOf(name: string, isDir: boolean): FileKind {
  if (isDir) return 'folder'
  return EXT_MAP[extOf(name)] ?? 'file'
}

/**
 * 类型 → 人类可读的「类型」列文案。
 * Windows 资源管理器就是在这一列写「文件夹 / JPG 图像 / MP4 视频」，
 * 让用户不用看扩展名也能判断内容。
 */
export function kindLabel(name: string, isDir: boolean): string {
  if (isDir) return '文件夹'
  const ext = extOf(name).toUpperCase()
  switch (kindOf(name, false)) {
    case 'image': return ext ? `${ext} 图像` : '图像'
    case 'video': return ext ? `${ext} 视频` : '视频'
    case 'audio': return ext ? `${ext} 音频` : '音频'
    case 'archive': return ext ? `${ext} 压缩文件` : '压缩文件'
    case 'document': return ext ? `${ext} 文档` : '文档'
    case 'code': return ext ? `${ext} 源文件` : '源文件'
    case 'apk': return ext ? `${ext} 应用程序` : '应用程序'
    case 'font': return ext ? `${ext} 字体` : '字体'
    default: return ext ? `${ext} 文件` : '文件'
  }
}

/** 类型 → 单色线性 SVG 图标路径（代替 emoji，尺寸整齐、辨识度高） */
export function fileIconOf(name: string, isDir: boolean): string {
  const k = kindOf(name, isDir)
  const paths: Record<FileKind, string> = {
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM21 15l-5-5L5 21',
    video: 'M3 5h18v14H3zM10 9l5 3-5 3Z',
    audio: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    archive: 'M4 4h16v4H4zM5 8h14v12H5zM10 12h4',
    document: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h8',
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 4l-4 16',
    apk: 'M12 2 3 7v10l9 5 9-5V7ZM3 7l9 5 9-5M12 12v10',
    font: 'M4 20 10 4h4l6 16M6.5 14h11',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6',
  }
  return paths[k]
}

/** 类型 → 图标着色（低调的单色，不给内容抢注意力） */
export function fileIconTone(name: string, isDir: boolean): string {
  const k = kindOf(name, isDir)
  switch (k) {
    case 'folder': return 'text-amber-600'
    case 'image': return 'text-violet-600'
    case 'video': return 'text-rose-600'
    case 'audio': return 'text-emerald-600'
    case 'archive': return 'text-orange-600'
    case 'document': return 'text-blue-600'
    case 'code': return 'text-cyan-700'
    case 'apk': return 'text-lime-700'
    case 'font': return 'text-fuchsia-600'
    default: return 'text-[--color-ink-faint]'
  }
}

/** 视频类 —— 与 EXT_MAP 的 video 段保持一致 */
export function isVideo(name: string): boolean {
  return kindOf(name, false) === 'video'
}

/** 后端 Pillow 无法解码的图片格式（发请求只会拿到 415，白费一次往返） */
const NO_THUMB_EXT = new Set(['svg', 'heic'])

/**
 * 是否值得向后端要缩略图（图片 + 视频）。
 *
 * 比 isImage 更宽（含视频），但也更窄 —— 排除了 Pillow 默认构建
 * 解不开的格式：svg 不是栅格图，heic 需要 pillow-heif 插件。
 * 这两类直接走 emoji，省掉一次必然失败的请求。
 */
export function hasThumbnail(name: string): boolean {
  const k = kindOf(name, false)
  if (k === 'video') return true
  if (k !== 'image') return false
  return !NO_THUMB_EXT.has(extOf(name))
}

/**
 * 归一化相对路径：统一分隔符、吃掉 . 与 ..、去掉空段。
 *
 * 用于文件夹上传。浏览器给的 `File.name` 永远是纯文件名，
 * 目录信息只能靠我们自己拼 —— 拼接结果必须先过这一层，
 * 再交给后端做第二道校验。
 */
export function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}

// ═══════════════════════════════════════════════════════════════════
// 其他
// ═══════════════════════════════════════════════════════════════════

/** 简易唯一 id */
export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 延迟 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 合并 className，过滤假值 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 把可能为空的错误转成可读文本 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return '未知错误'
}
