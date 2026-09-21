# WorkBuddy Disk

一个跑在单端口上的轻量网盘系统。Python + Flask，前端零依赖，在单个文件里把后端与页面打包完毕。

## 它解决什么问题

线上网关对单个请求体有约 **50MB** 的硬限制，超过直接返回 `413` 且**请求根本到不了应用层** —— 所以你在日志里什么都看不到，只能看到一个失败。这个项目用**前端分片**绕开它：大于阈值的文件切成 48MB 的片逐片上传，服务端落盘暂存后合并。

## 功能

- **目录浏览** — 子目录导航、路径面包屑
- **上传** — 小文件直传；大文件自动分片（绕过网关限制）
- **多文件并发上传** — 并发数可配（1~10），单文件失败不阻塞其他文件
- **文件夹上传** — 保留目录结构（`dirmode`），目录按需幂等创建
- **下载** — 支持 HTTP Range 断点续传
- **媒体缩略图** — 图片与视频生成 WebP 缩略图，磁盘缓存 + mtime 失效
- **文件管理** — 新建文件夹、重命名、批量删除
- **鉴权** — 网页会话（Cookie）+ API Key 双通道
- **API Key 管理** — 设置页内新建 / 停用 / 改名 / 删除
- **危险操作开关** — 一键禁止 API Key 执行删除类操作

## 两套操作方式

桌面端与移动端的文件操作入口不同，因为「悬停」在触摸屏上不存在：

| | 桌面端（≥640px） | 移动端（<640px） |
| --- | --- | --- |
| 打开 | 单击行 | 单击行 |
| 操作入口 | 悬停显示圆形按钮组 | **长按 500ms** 弹出底部抽屉 |
| 多选 | 复选框悬停显隐 | 长按抽屉内的操作项 |

长按的几条硬约束（都是踩过坑后的定论）：

- `onPointerDown` 里**绝不 `preventDefault()`** —— 会让浏览器认定该元素
  不参与滚动手势，列表再也滚不动。改用「位移 > 10px 取消长按」来区分
  「按住不动」与「滑动列表」
- 长按触发后，抬指时浏览器会补发一次 `click`，必须在 **capture 阶段**
  吞掉，否则会顺带进入目录 / 打开预览
- `pointerType === 'mouse'` 直接跳过 —— 桌面按住是拖选行为
- 浮层层级：`UploadPanel 60` < `抽屉遮罩 69 / 抽屉 70` < `Modal 80`，
  这样从抽屉点「删除」弹出的确认框才能盖在抽屉之上

## 快速开始

```bash
# 访问密钥通过环境变量注入，缺省值仅用于开箱可用
export NETDISK_KEY="你的密钥"

python3 app.py          # 默认监听 8000
# 或
PORT=8080 python3 app.py
```

打开 `http://localhost:8000`，输入密钥即可。

### 进程管理

```bash
./run.sh start     # 后台启动
./run.sh stop      # 停止
./run.sh restart   # 重启
./run.sh status    # 查看状态
```

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NETDISK_KEY` | `lijiaxu2011` | 网页登录密钥 |
| `NETDISK_SESSION_TTL` | `604800`（7 天） | 会话有效期（秒） |
| `PORT` | `8000` | 监听端口 |

代码内常量（`app.py` 顶部）：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `CHUNK_SIZE` | 48 MB | 分片大小，必须小于网关限制 |
| `CHUNK_THRESHOLD` | 48 MB | 超过此值走分片 |
| `MAX_FILE_SIZE` | 2 GB | 单文件上限 |
| `UPLOAD_SESSION_TTL` | 24 小时 | 未完成分片会话保留时长 |

## API Key

用 `?apikey=KEY` 查询参数或 `X-API-Key` 请求头调用，全套接口可用。

```bash
KEY="ndk_xxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
BASE="http://localhost:8000"

curl "$BASE/api/list?apikey=$KEY"
```

> ⚠️ **不要用 `Authorization: Bearer`** —— 部分线上网关会用自签 JWT 覆盖这个头，导致凭证丢失。

密钥在磁盘上**只存 SHA-256 哈希**，明文仅在创建时返回一次。

## 大文件上传流程

```
POST /api/upload/init      → 拿 upload_id、chunk_size、total_chunks
POST /api/upload/chunk     → 循环传每片（form-data: upload_id / index / chunk）
POST /api/upload/complete  → 合并
        /api/upload/abort  → 失败时清理临时分片
```

## 接口一览

| 方法 | 路径 | 说明 | 危险操作 |
| --- | --- | --- | --- |
| GET | `/api/list` | 列目录 | |
| GET | `/api/stats` | 存储统计 | |
| GET/POST | `/api/settings` | 读写设置 | |
| GET/POST | `/api/apikeys` | 列出 / 新建 Key | |
| PATCH/DELETE | `/api/apikeys/<id>` | 启停改名 / 删除 | |
| POST | `/api/upload` | 小文件直传 | |
| POST | `/api/upload/init` | 分片：建会话 | |
| POST | `/api/upload/chunk` | 分片：传一片 | |
| POST | `/api/upload/complete` | 分片：合并 | |
| POST | `/api/upload/abort` | 分片：中止 | ✅ |
| GET | `/api/upload/status` | 查会话状态 | |
| GET | `/api/download` | 下载（支持 Range） | |
| GET | `/api/thumbnail` | 媒体缩略图（图片/视频，WebP） | |
| POST | `/api/delete` | 删除 | ✅ |
| POST | `/api/rename` | 重命名 | ✅ |
| POST | `/api/mkdir` | 新建文件夹 | ✅ |
| GET | `/api/whoami` | 查登录状态 | |

### 文件夹上传（`dirmode`）

`/api/upload` 与 `/api/upload/init` 都支持一个可选的 `dirmode` 参数。开启后
**保留文件名里的目录结构**，并按需幂等创建目录：

```bash
# 直传：filename 带目录 → storage/photos/2024/a.jpg（目录自动创建）
curl -X POST "$BASE/api/upload" -H "X-API-Key: $KEY" \
  -F "path=photos" -F "dirmode=true" -F "files=@a.jpg;filename=2024/a.jpg"
```

- `path` 在 `dirmode` 下**允许不存在**，会被逐级创建（不带 `dirmode` 时仍是 404）
- 目录**幂等复用、绝不改名**；同名文件仍走自动改名（`a.jpg` → `a (1).jpg`）
- 响应中每条结果额外带 `rel_path`（相对存储根的完整路径）
- ⚠️ 之所以在上传接口内建目录、而不是让调用方逐级调 `/api/mkdir`：
  `/api/mkdir` 属于危险操作，API Key 在 `allow_dangerous=false` 时会被 403；
  而本接口不在危险清单内，因此**文件夹上传不受该开关限制**。

### 缩略图

```bash
curl "$BASE/api/thumbnail?path=photo/a.jpg" -H "X-API-Key: $KEY" -o t.webp
```

- 支持图片（Pillow）与视频（ffmpeg 抽首帧），统一输出 WebP，最长边默认 300px
- 缓存在 `.thumb_cache/`，key 为 `sha256(路径 | mtime | 大小 | 尺寸)` ——
  源文件 mtime 变化即自动失效
- 不支持的类型返回 `415`，源文件不存在返回 `404`；前端据此回退到 emoji 图标

## 安全设计

- **路径穿越防护** — `Path.resolve()` + 前缀校验，拒绝 `../`、空字节、绝对路径
- **常数时间比对** — `hmac.compare_digest()` 防时序攻击
- **签名 Token** — `<过期时间戳>.<HMAC-SHA256>`，签名盐进程启动时随机生成、不落盘
- **API Key 哈希存储** — 只存 SHA-256，文件权限 600
- **危险操作隔离** — 开关关闭后 API Key 无法调用删除类接口

> 服务重启后所有网页会话失效（盐重新随机）。这是有意的取舍：不把密钥写进磁盘。

## 依赖

核心只需 **Flask**（其余全是标准库），服务即可完整运行：

```bash
pip install flask
```

以下两项是**可选增强**，只影响缩略图功能。缺失时服务照常启动，对应类型
的缩略图请求会返回 415，前端自动回退到 emoji 图标：

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| [Pillow](https://python-pillow.org/) | 图片缩略图 | 图片无缩略图 |
| `ffmpeg` 可执行文件 | 视频首帧缩略图 | 视频无缩略图 |

```bash
pip install pillow            # 图片缩略图（可选）
# ffmpeg 请用系统包管理器安装，或用 NETDISK_FFMPEG 指定路径
```

> 缩略图相关的环境变量：`NETDISK_THUMB_SIZE`（边长，默认 300）、
> `NETDISK_THUMB_TIMEOUT`（单张生成超时秒数，默认 20）、
> `NETDISK_THUMB_TTL`（缓存保留秒数，默认 30 天）、
> `NETDISK_THUMB_MAX_INPUT`（源文件大小上限，默认 64MiB）、
> `NETDISK_FFMPEG`（ffmpeg 路径，默认 `/usr/local/bin/ffmpeg`）。

## 说明

`storage/`（用户文件）、`.config/`（API Key 与设置）、`.thumb_cache/`（缩略图缓存）、
`*.log` 已在 `.gitignore` 中排除，不会入库。
