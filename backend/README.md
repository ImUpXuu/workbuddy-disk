# WorkBuddy Disk · 后端

> 📌 **这是 `workbuddy-disk` 仓库的后端子目录。** 总览与部署说明见[仓库根 README](../README.md)。
>
> 本目录是**后端归档副本**，包含 Flask API 与一个内嵌网页版界面（零依赖、单文件，作为前端不可用时的兜底入口）。
> 正式前端在 [`../frontend`](../frontend)，部署于 Vercel。

一个跑在单端口上的轻量网盘系统。Python + Flask，前端零依赖，在单个文件里把后端与页面打包完毕。

## 它解决什么问题

线上网关对单个请求体有约 **50MB** 的硬限制，超过直接返回 `413` 且**请求根本到不了应用层** —— 所以你在日志里什么都看不到，只能看到一个失败。这个项目用**前端分片**绕开它：大于阈值的文件切成 48MB 的片逐片上传，服务端落盘暂存后合并。

## 功能

- **目录浏览** — 子目录导航、路径面包屑
- **上传** — 小文件直传；大文件自动分片（绕过网关限制）
- **多文件并发上传** — 并发数可配（1~10），单文件失败不阻塞其他文件
- **下载** — 支持 HTTP Range 断点续传
- **文件管理** — 新建文件夹、重命名、批量删除
- **鉴权** — 网页会话（Cookie）+ API Key 双通道
- **API Key 管理** — 设置页内新建 / 停用 / 改名 / 删除
- **危险操作开关** — 一键禁止 API Key 执行删除类操作

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
| `NETDISK_KEY` | `change-me` | 网页登录密钥，**务必修改** |
| `NETDISK_CORS_ORIGINS` | 内置白名单 | 允许的跨域来源，逗号分隔 |
| `NETDISK_PORT` / `PORT` | `8000` | 监听端口 |
| `NETDISK_HOST` | `0.0.0.0` | 监听地址 |
| `NETDISK_TOKEN_TTL` | `604800`（7 天） | 登录 Token 有效期（秒） |

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
| POST | `/api/delete` | 删除 | ✅ |
| POST | `/api/rename` | 重命名 | ✅ |
| POST | `/api/mkdir` | 新建文件夹 | ✅ |
| GET | `/api/whoami` | 查登录状态 | |

## 安全设计

- **路径穿越防护** — `Path.resolve()` + 前缀校验，拒绝 `../`、空字节、绝对路径
- **常数时间比对** — `hmac.compare_digest()` 防时序攻击
- **签名 Token** — `<过期时间戳>.<HMAC-SHA256>`，签名盐进程启动时随机生成、不落盘
- **API Key 哈希存储** — 只存 SHA-256，文件权限 600
- **危险操作隔离** — 开关关闭后 API Key 无法调用删除类接口

> 服务重启后所有网页会话失效（盐重新随机）。这是有意的取舍：不把密钥写进磁盘。

## 依赖

见 [`requirements.txt`](./requirements.txt)，实际只需 **Flask**（其余全是标准库）：

```bash
pip install -r requirements.txt
```

## 跨域（CORS）

前端部署在 `pan.upxuu.com`，与后端不同源，需要：

```bash
export NETDISK_CORS_ORIGINS='https://pan.upxuu.com,http://localhost:5173'
```

- 预检 `OPTIONS` 在鉴权前短路放行，否则浏览器会拿到 `401` 而直接判定跨域失败
- 响应注入 `Access-Control-Allow-Origin` / `-Methods` / `-Headers` / `-Max-Age`
- 请求自带 `Origin` 且命中白名单时，回显该 `Origin` 并附 `Vary: Origin`，以便将来支持多域名与 `Allow-Credentials`

## 说明

`storage/`（用户文件）、`.config/`（API Key 与设置）、`*.log` 已在 `.gitignore` 中排除，不会入库。
