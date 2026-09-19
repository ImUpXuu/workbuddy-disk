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

/** 类型 → emoji 图标（轻量，不需要图标库） */
const ICONS: Record<FileKind, string> = {
  folder: '📁',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  archive: '🗜️',
  document: '📄',
  code: '📜',
  apk: '📦',
  font: '🔤',
  file: '📎',
}

export function iconOf(name: string, isDir: boolean): string {
  return ICONS[kindOf(name, isDir)]
}

/** 类型 → 图标底色（Tailwind 类名） */
const KIND_BG: Record<FileKind, string> = {
  folder: 'bg-amber-100 text-amber-700',
  image: 'bg-violet-100 text-violet-700',
  video: 'bg-rose-100 text-rose-700',
  audio: 'bg-emerald-100 text-emerald-700',
  archive: 'bg-orange-100 text-orange-700',
  document: 'bg-blue-100 text-blue-700',
  code: 'bg-cyan-100 text-cyan-700',
  apk: 'bg-lime-100 text-lime-700',
  font: 'bg-fuchsia-100 text-fuchsia-700',
  file: 'bg-slate-100 text-slate-600',
}

export function iconBgOf(name: string, isDir: boolean): string {
  return KIND_BG[kindOf(name, isDir)]
}

/** 是否可在浏览器里预览（新标签页打开） */
export function isPreviewable(name: string): boolean {
  const k = kindOf(name, false)
  return k === 'image' || k === 'video' || k === 'audio' || k === 'document' || k === 'code'
}

/** 图片类才用 <img> 缩略图，其他用 emoji，避免大量请求 */
export function isImage(name: string): boolean {
  return kindOf(name, false) === 'image'
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
