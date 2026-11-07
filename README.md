# workbuddy-disk

一个自托管的轻量网盘：**Flask 后端 + React 前端**，前后端分离，同一个仓库。

| 目录 | 内容 | 部署位置 |
| --- | --- | --- |
| [`backend/`](./backend) | Flask 单文件后端，提供 JSON API + 一个内嵌网页版界面（兜底用） | 自有服务器 / 沙箱，监听 `:8000` |
| [`frontend/`](./frontend) | Vite + React + Tailwind v4 单页应用 | [Vercel](https://vercel.com) → `pan.upxuu.com` |

---

## 架构

```
浏览器 ──── https://pan.upxuu.com ────┐
                                      │  Vercel 托管静态资源
                                      │
        X-API-Key / ?token=           │  跨域请求（CORS）
                                      ▼
                        https://<后端域名>   Flask API
                                      │
                                      ▼
                                  storage/  用户文件
```

前端与后端**不同源**，因此所有请求都是跨域：

- 后端放行 `OPTIONS` 预检，并回显白名单内的 `Origin`
- 凭证优先走 `X-API-Key` 请求头（key 存在 `localStorage`）
- 次选 `?token=` 查询参数，兼容不支持自定义头的场景
- Cookie 通道保留，但跨站场景（`SameSite=Lax`）不作为主通道

---

## 快速开始

### 后端

```bash
cd backend
pip install -r requirements.txt

# 必改：登录密钥与 CORS 白名单
export NETDISK_KEY='your-strong-key'
export NETDISK_CORS_ORIGINS='https://pan.upxuu.com,http://localhost:5173'

python3 app.py          # 或 ./run.sh
```

默认监听 `0.0.0.0:8000`。启动后直接访问 `http://localhost:8000` 就是内嵌网页版。

### 前端

```bash
cd frontend
pnpm install

# 指向后端地址
echo 'VITE_API_BASE=http://localhost:8000' > .env.local

pnpm dev                # http://localhost:5173
pnpm build              # 产物在 dist/，可直接丢给 Vercel
```

### 部署到 Vercel

1. Import 仓库，**Root Directory 选 `frontend`**
2. Framework Preset 自动识别为 Vite
3. 环境变量加 `VITE_API_BASE=https://<你的后端域名>`
4. 绑定域名 `pan.upxuu.com`
5. 把该域名加进后端的 `NETDISK_CORS_ORIGINS`

---

## 主要接口

| 方法 | 路径 | 说明 | 需登录 |
| --- | --- | --- | --- |
| `POST` | `/api/login` | 用登录密钥换 token | — |
| `GET` | `/api/list?path=` | 列目录 | ✓ |
| `GET` | `/api/download?path=` | 下载文件（支持 `Range`） | ✓ |
| `POST` | `/api/mkdir` | 新建文件夹 | ✓ |
| `POST` | `/api/rename` | 重命名 / 移动 | ✓ |
| `POST` | `/api/delete` | 删除 | ✓ |
| `POST` | `/api/upload/init` | 初始化分片上传 | ✓ |
| `POST` | `/api/upload/chunk` | 上传分片 | ✓ |
| `POST` | `/api/upload/complete` | 合并分片 | ✓ |
| `GET` | `/api/settings` | 读取设置 | ✓ |
| `POST` | `/api/settings` | 保存设置 | ✓ |
| `GET` | `/api/apikeys` | API Key 列表 | ✓ |
| `POST` | `/api/apikeys` | 新建 API Key | ✓ |
| `PATCH` | `/api/apikeys/<id>` | 改名 / 启停 | ✓ |
| `DELETE` | `/api/apikeys/<id>` | 删除 API Key | ✓ |
| `GET` | `/api/shares` | 列出全部分享（管理） | ✓ |
| `POST` | `/api/shares` | 新建分享（`path` / `expires_days`） | ✓ |
| `PATCH` | `/api/shares/<id>` | 启停 / 改有效期 | ✓ |
| `DELETE` | `/api/shares/<id>` | 撤销分享 | ✓ |
| `GET` | `/api/share/<token>` | 公开查看分享内容（**免登录**） | — |
| `GET` | `/api/share/<token>/download` | 公开下载（**免登录**） | — |
| `GET` | `/api/share/<token>/thumbnail` | 公开缩略图（**免登录**） | — |
| `PROPFIND`/`GET`/`PUT`/`DELETE`/`MKCOL`/`MOVE`/`COPY` | `/dav/...` | **WebDAV** 协议挂载（HTTP Basic Auth） | key |

完整参数与 `curl` 示例见 [`backend/API使用说明.md`](./backend/API使用说明.md)。

---

## 分享链接

把任意目录或文件变成一条**免登录**即可打开的公开链接。数据模型参考 OpenList 的
`Share`（密码 / 访问次数上限 / 说明 / 排序）。

```bash
# 分享某个目录（返回 token 与公开链接 /#/s/<token>）
curl -X POST "$BASE/api/shares" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"photos/2024","expires_days":0,"pwd":"s123","max_accessed":100,
       "remark":"给客户","readme":"目录说明","header":"置顶公告","order_by":"size","order_direction":"desc"}'

# 任何人拿链接都能直接看（有密码时带 ?pwd=）
curl "$BASE/api/share/<token>?pwd=s123"
curl "$BASE/api/share/<token>/download?path=photos/2024/a.jpg&pwd=s123"
```

新建 / 编辑（`POST /api/shares`、`PATCH /api/shares/<id>`）可用字段：

| 字段 | 说明 |
|---|---|
| `path` | 要分享的文件或目录（相对存储根） |
| `expires_days` | 有效天数，`0` 永不过期 |
| `id` | 自定义短链 ID（可选，不填自动生成） |
| `pwd` | 访问密码；非空时查看 / 下载 / 缩略图都要带 `?pwd=` |
| `max_accessed` | 最大访问次数，`0` 不限；打开分享根累计一次，达到即失效 |
| `remark` / `readme` / `header` | 备注 / 目录说明 / 置顶公告（前端展示用） |
| `order_by` | 列表排序：`name` / `size` / `mtime` / `none` |
| `order_direction` | `asc` / `desc` |

- 目录分享覆盖整个子树；文件分享只暴露那一个文件。
- 链接即凭证：`token` 是 URL 里唯一的保密要素，泄露等同于内容泄露，
  因此服务端**明文存储**（与 API Key 的哈希存储不同）。
- 过期 / 停用 / 撤销 / 访问次数用尽都立即 404；密码错误返回 `401 + need_password`。
- 范围校验：下载与缩略图都过 `share_allows()` + 密码校验，越权直接拒绝。
- 前端用 **hash 路由**（如 `#/d/photos/2024`、`#/s/<token>`），服务端永远只服务 `/`。

> ⚠️ 分享链接是公开入口，发给别人即代表授权其访问对应内容；
> 不再需要时请到「分享管理」页撤销。

## 权限管理 / 游客可见目录 / 元信息

采用**单主人 + 匿名游客**模型（不做多用户账号）。核心是「目录元信息（meta）」——
参考 OpenList 的 `Meta`：按路径给目录配置访问规则，规则可递归作用于子树。

> 数据存储：`.config/metas.json`（权限 600）。规则按路径深度「最具体优先」，
> 逐字段「首次命中锁定」，因此能给子目录单独设 `guest_read=false` 关闭开放。

### 元信息规则字段

| 字段 | 说明 |
|---|---|
| `path` | 规则作用的目录（相对存储根，空串 = 全盘根规则） |
| `guest_read` | **是否对游客开放**（默认全盘关闭） |
| `guest_read_sub` | 开放是否递归到子目录（默认 `true`） |
| `password` | 该目录的访问密码（游客需带 `?pwd=`） |
| `write` / `write_sub` | 预留的游客写权限开关 |
| `hide` | 隐藏文件正则（每行一个），对列目录和直接下载都生效 |
| `readme` / `header` | 目录说明 / 置顶公告 |
| `p_sub`/`h_sub`/`r_sub`/`header_sub` | 密码 / 隐藏 / 说明 / 公告是否递归 |

### 管理接口（需鉴权）

```bash
curl -H "X-API-Key: $KEY" "$BASE/api/metas"                    # 列出全部规则
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"path":"public","guest_read":true,"password":"abc","hide":"^_"}' \
  "$BASE/api/metas"                                              # 新建/更新(id=0 新建, 带 id 编辑)
curl -X DELETE -H "X-API-Key: $KEY" "$BASE/api/metas/1"        # 删除
curl -H "X-API-Key: $KEY" "$BASE/api/metas/effect?path=public/x"  # 调试: 查看某路径生效的约束
```

### 游客公开浏览（免登录）

默认游客看不到任何东西；只有被 `guest_read` 标记的目录及其子树可访问。
密码随每次请求以 `?pwd=` 或 `X-Guest-Pwd` 头传递，服务端无状态。

```bash
curl "$BASE/api/public/roots"                       # 游客落地页: 列出开放的顶层入口
curl "$BASE/api/public/list?path=public&pwd=abc"   # 列目录(应用 hide/readme/header)
curl "$BASE/api/public/file?path=public/a.txt&download=1&pwd=abc"  # 下载
curl "$BASE/api/public/thumbnail?path=public/a.jpg&pwd=abc"        # 缩略图
```

- 未开放目录 → `403`；需要密码 → `401 + need_password`。
- `hide` 正则同时过滤列目录与「按名字直接下载」，避免绕过。
- 已登录主人走原有 `/api/list` 等接口，不受这些规则限制。

## WebDAV

后端实现了标准 **WebDAV** 协议，可把整个网盘像本地磁盘一样挂载到
Windows 资源管理器 / macOS Finder / rclone / Cyberduck 等客户端，
直接拖拽读写，无需走网页。

- 挂载点：`/dav/`（即存储根目录）
- 鉴权：**HTTP Basic Auth**。用户名任意（如 `admin`），密码填
  - 你的**登录密钥**（`NETDISK_KEY`，网页登录用的那串），或
  - 任意一个 **API Key**（受 `allow_dangerous` 开关约束，与 REST API 一致）
- 支持的方法：`OPTIONS` `PROPFIND` `GET` `HEAD` `PUT` `DELETE` `MKCOL`
  `MOVE` `COPY` `PROPPATCH` `LOCK` `UNLOCK`，`GET` 支持 `Range` 断点续传。
- 所有路径都过 `safe_path()` 前缀校验，杜绝 `../` 穿越。

```bash
# 能力探测（无需认证）
curl -X OPTIONS "$BASE/dav/"

# 列根目录（密码 = 登录密钥，用户名随意）
curl -u "admin:$KEY" -X PROPFIND "$BASE/dav/" -H "Depth: 1"

# 上传 / 下载
curl -u "admin:$KEY" -X PUT  "$BASE/dav/hello.txt" -d "hi"
curl -u "admin:$KEY"         "$BASE/dav/hello.txt"
```

> 网页端点开顶栏或侧栏的 **WebDAV** 按钮，可直接复制服务器地址与填法。

### 鉴权凭证

三种通道，按优先级：

1. **API Key**（推荐给前端与外部程序）
   ```
   X-API-Key: ndk_xxxxxxxx_yyyyyyyyyyyyyyyy
   ```
   或 `?apikey=ndk_...`。key 在设置页创建，服务端只存 `sha256` 哈希。

2. **登录 Token**
   ```
   ?token=<expire_ts>.<base64url_sig>
   ```
   或 `Authorization: Bearer <token>`（注意：某些反向代理会覆写该头）。

3. **Cookie** `netdisk_token`，仅同源场景可靠。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NETDISK_KEY` | `change-me` | 网页登录密钥，**务必修改** |
| `NETDISK_CORS_ORIGINS` | 内置白名单 | 允许的跨域来源，逗号分隔；支持 `*` |
| `NETDISK_PORT` | `8000` | 监听端口 |
| `NETDISK_HOST` | `0.0.0.0` | 监听地址 |
| `NETDISK_TOKEN_TTL` | `604800` | Token 有效期（秒），默认 7 天 |
| `NETDISK_MAX_UPLOAD_MB` | `2048` | 单文件大小上限（MB） |
| `NETDISK_CHUNK_MB` | `48` | 分片大小（MB） |

---

## 安全设计

- **API Key** 明文只在创建时返回一次，磁盘仅存 `sha256("netdisk-apikey:" + secret)`
- **Token** 为 `HMAC-SHA256` 签名，密钥进程启动时随机生成 → 重启即全部失效
- **危险操作**（删除 / 重命名 / 新建文件夹）可被设置项一键禁用，API Key 亦可单独限制
- **路径穿越**已做 `resolve()` 校验，越界一律 403
- **用户数据**（`storage/`）、**配置与 Key 哈希**（`.config/`）均在 `.gitignore` 中，不会入库

---

## License

MIT
