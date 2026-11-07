# 网盘（OpenList Go 后端 + Vercel 前端）

一个自托管网盘：**OpenList 官方 Go 后端 + OpenList 官方 SolidJS 前端**，前后端分离部署，同一个仓库。
前端只保留 UI 外壳，文件管理、分享、元信息、权限、WebDAV、多存储挂载、分片上传等能力全部由 Go 后端原生提供。

| 目录 | 内容 | 部署位置 |
| --- | --- | --- |
| [`frontend/`](./frontend) | OpenList 官方 SolidJS 前端 v4.2.9（仅少量网关/Vercel 兼容改动 + 全量语言包） | [Vercel](https://vercel.com) → `pan.upxuu.com` |
| [`backend-openlist/`](./backend-openlist) | Go 后端的定制鉴权中间件（`?token=` 优先 + 游客降级）、50MB 分片默认值、服务器状态接口与一键编译脚本 | 不部署，仅供升级复用 |
| [`backend/`](./backend) | 旧 Flask 后端（**已停用，仅留档**） | 不再启动 |

后端实际运行体（二进制 + `data/`）在部署机的 `/workspace/netdisk`，不在本仓库内。

---

## 架构与部署拓扑

```
浏览器 ── https://pan.upxuu.com (Vercel 静态前端) ──┐
                                                    │ 前端 JS 直连后端绝对域名（跨域）
                                                    ▼
              https://<后端域名>.app.workbuddy.host (CloudStudio 网关 :8000)
                                                    │
                                                    ▼
              /workspace/netdisk/openlist (OpenList Go 后端)
                    ├── openlist-data/data.db  用户/存储/元信息/分享
                    └── 本地存储 / 挂载的其他网盘驱动
```

- 前端静态资源由 Vercel 托管，`vercel.json` 把任意路径 rewrite 到 `/index.html`（history 模式 SPA fallback）。
- 前端通过 `.env.production` 的 `VITE_API_URL` 注入后端**绝对域名**，`request.ts` 里 `baseURL = api + "/api"`。
- 后端 CORS 三项均为 `["*"]`，`withCredentials: false`，跨域请求放行。
- Vercel 侧**收不到 `/api` 流量**，因此不需要为 `/api` 开 rewrite 例外、也不要把 `/api` 代理到后端。

---

## 为什么用 `?token=`（网关兼容）+ 游客为何能直接进

实测 CloudStudio 预览网关的行为不是"剥离头"，而是**把 `Authorization` 请求头覆盖成它自己的一个失效 token**：
经网关的请求，无论客户端带头、带 `?token=`、甚至完全不带凭证，后端看到的都是一个非空但无效的
`Authorization`；而**任意 query 参数都能可靠透传**。

OpenList Go 后端 `server/middlewares/auth.go` 的 `Auth` / `Authn` 只读
`c.GetHeader("Authorization")`，于是出现两类问题：

1. 已登录用户：网关的失效头盖掉真实 token → 401；
2. **游客（guest 已开启）**：后端把网关塞的脏头当成「登录态但 token 无效」直接 401，前端 `MustUser`
   守卫看到 401 就 `bus.emit("to", "/@login?...")`，表现为「明明开了 guest 还是被弹到登录页」；
   点「使用游客」回到首页后再次 401，形成来回重定向。本地直连无网关时 `/api/me` 正常返回
   `200 guest`，所以问题只在经网关时暴露。

修复方式：用 [`backend-openlist/files/auth.go`](./backend-openlist/files/auth.go) **整体覆盖**官方同名文件
（差异留档于 `patches/token-from-query.patch` 与 `patches/guest-fallback.patch`，由 `build.sh` 编译时安装）：

| 侧 | 改动 |
| --- | --- |
| 后端 | ① `requestToken()`：`?token=` 只要**出现**（含空串）就覆盖 Header，空串即「我是游客」，把网关脏头清空；② `fallbackOrAbort()`：token 解析 / 校验失败且 guest 未禁用时**降级为游客**而非 401；guest 被禁用或后端异常时仍返回 401 / 500；③ `server/handles/auth.go` 的 `LogOut` 同样兼容 `?token=` |
| 前端 | `src/utils/request.ts` 请求拦截器**每次请求都注入** `token` 参数：已登录为 JWT，未登录为空串（显式声明游客身份）；业务自带 `token` 参数时不覆盖 |

`Authorization` 默认头保留不改（本地直连仍可用），后端以 `?token=` 为准。
OpenList 的业务错误是 **HTTP 200 + body `{code,message,data}`**，由 `handle_resp.ts` 按 `resp.code`
判断（含 401 跳登录），不受影响。

**安全性**：降级只会得到 `guest` 身份，`/api/admin/*` 后还有 `AuthAdmin` 拦截（实测游客访问状态接口返回
`403 You are not an admin`），不存在提权；游客访问 `/@manage/*` 仍会跳登录页，这是预期行为。

---

## 联调实测结论（2026-11-07）

以生产构建前端（`VITE_API_URL` 指向网关绝对域名）+ 沙箱 Go 后端 + CloudStudio 网关实跑，全链路通过：

| 环节 | 实测结果 |
| --- | --- |
| 网关鉴权 | 本地 / 经网关 `GET /api/me?token=<有效>` 均 `200 admin`；经网关不带 token（游客）返回 `200 guest`；`/api/admin/server/status` 游客 `403`、管理员 `200` |
| CORS 预检 | `OPTIONS` 经网关返回 `204`，`allow-origin/headers/methods = *` |
| 列目录 | `POST /api/fs/list?token=` 经网关 `200`，正确返回根目录文件与中文目录 |
| 普通上传 | `PUT /api/fs/put?token=` + `File-Path` 头经网关 `200`，文件正确落地 |
| 分片上传 | 11 MB / 两片、60 MB / **50MB + 10MB** 两片，经网关 `init → chunk×N → complete` 全 `200`，sha256 一致；`abort` / 状态查询 / 重传正常 |
| 预览下载 | `POST /api/fs/get?token=` `200` → 签发 `/p/hello.txt?sign=...` → 经网关 `200` 返回文件正文 |
| 浏览器 E2E | 登录 → `localStorage.token` 落库 → 列表渲染、进入子路由预览显示正文；**零 console 错误、零失败请求** |
| 游客访问 | 线上 `pan.upxuu.com` / 本地新前端 / 浏览器残留失效 token / 点「使用游客」四种场景均**停在首页不跳登录页**，`/api/me` 为 `200 guest`、文件列表正常渲染、零 console 错误 |
| 多语言 | 中文浏览器自动中文、旧版存量 `lang=en` 自动迁移、显式选过的语言保持不变、英文浏览器英文；四种场景零报错 |

> **下载为何不需要 token**：OpenList 的 `/d/`、`/p/` 下载路由走后端签发的 `sign` 查询参数
> （由 `fs/get` 用 `?token=` 鉴权后返回），不依赖 `Authorization` 头，因此天然免疫网关覆盖头。
> 结论：**只需为 `/api` 请求注入 `?token=`**，下载 / 预览链接保持官方原样即可。

**本地存储挂载**：OpenList 初始数据库不含任何 storage，必须先挂一个驱动，否则
`POST /api/fs/list` 返回 `storage not found; please add a storage first`。
管理页 **存储 → 添加**，或调用 `POST /api/admin/storage/create`（`driver=Local`，
`mount_path=/`，`addition={"root_folder_path":"<数据目录>",...}`）。挂载后 `/api/fs/list` 即正常。
完整版 Go 二进制全量导入 drivers，可继续挂载对象存储 / OneDrive / 115 / 阿里云盘 / WebDAV / S3 等。

**默认设置清理**：首次启动的 `site_title=OpenList` 与欢迎公告属默认值，已通过
`POST /api/admin/setting/save` 改为「我的网盘」并清空公告；这些是数据库运行数据，不入库。

---

## WebDAV（2026-11-07 实测）

WebDAV 由 OpenList Go 后端原生提供，路径 `/dav`。官方 `WebDAVAuth` 只认 `Authorization`
里的 `Basic user:pass` / `Bearer <静态Token>`，而这个头会被网关覆盖成失效 token——
因此**官方实现经网关时所有 PROPFIND 都返回 401**，Windows 资源管理器会报
「输入的文件夹似乎无效」。本地直连 `http://127.0.0.1:8000/dav/` 则一切正常。

定制 [`backend-openlist/files/webdav.go`](./backend-openlist/files/webdav.go)（编译时整体覆盖官方
同名文件，差异留档 `patches/webdav-query-auth.patch`）给 `WebDAVAuth` 增加了不会被网关篡改的
凭证通道：

| 方式 | 示例 | 适用 |
| --- | --- | --- |
| `?token=` / `?key=` / `?apikey=` | `.../dav/?token=<静态Token>` | 通用，可写进 URL |
| `X-Openlist-Token` 请求头 | `<静态Token>` | rclone / davfs2 / RaiDrive 等可配 header 的客户端 |
| `Basic admin:密码` | 本地直连 | 不经网关时可用，经网关会被覆盖 |

凭证二选一：**后台静态 Token**（不过期，推荐长期挂载）或**网页登录 JWT**（48h，后端重启失效）。
解析成功后仍走官方 `CanWebdavRead` / `CanWebdavManage` 权限检查，不绕过鉴权；无效凭证返回 401。

> **地址必须是后端网关域名**，不是 `pan.upxuu.com`——Vercel 会把 `/dav/` rewrite 成前端首页，
> WebDAV 客户端会认为文件夹无效。
> `https://<后端域名>.app.workbuddy.host/dav/?token=<静态Token>`
> Windows 映射：`net use Z: "https://<后端域名>.app.workbuddy.host/dav/?token=<静态Token>"`；
> 若仍弹凭据框，说明客户端把 query 丢了，改用可配 `X-Openlist-Token` 头的客户端。

**实测（经网关，`?token=<静态Token>`）**：OPTIONS `200`（`DAV: 1, 2`）、PROPFIND `207`、
GET `200`、MKCOL `201`、PUT `201`、COPY `201`、MOVE `201`、PROPPATCH `207`、LOCK `200`、
DELETE `204`；`?key=` / `?apikey=` / `X-Openlist-Token` / `?token=<JWT>` 同样可用；
无凭证与无效凭证均 `401`。本地直连 Basic 全方法正常。

### 平台 WAF 限制（非代码问题）

腾讯云 WAF（`server: stgw`）会拦截 **PUT / COPY / MOVE 到带特定扩展名的路径**，返回
403 HTML 拦截页（不是后端响应）。实测黑名单：`txt php jsp asp aspx sh html htm sql env bak`；
其余 28 种常见扩展名（apk / jpg / png / rar / zip / 7z / mp4 / doc / docx / xls / xlsx /
pdf / exe / js / json / log / ini / conf / xml / csv / md / bin / dat / gz / iso / py / go）
均 `201` 正常写入，GET 读取这些文件不受影响。
这是平台层规则，应用层无法绕过；`.txt` 等文件请改用网页端上传（走 `/api/fs/put`，
路径不带扩展名，WAF 放行），或直连后端。

---

## 管理员与登录

- 初始化（v4.2.9）：**不要**先跑 `admin set`——首次无 admin 用户时它会报 `record not found`。
  正确做法是首次启动带环境变量（用户名固定 `admin`）：
  ```bash
  OPENLIST_ADMIN_PASSWORD='<密码>' ./openlist server --data <data>
  ```
  日志出现 `Successfully created the admin user` 即成功，数据库 `x_users` 出现 `admin`。
  平台启动命令固化在 `/workspace/.cloudstudio`（仓库外，含明文密码、权限 600、不入库）。
- 已有 admin 时该环境变量被忽略；改密可用 `admin set '<新密码>'`。
- 登录：前端 `POST /api/auth/login/hash`，密码按 `sha256(pwd + "-https://github.com/alist-org/alist")` 做静态 hash，返回 `data.token`（JWT，HS256）。
- **重启需重新登录**：JWT 校验用纯内存 `validTokenCache`（`server/common/auth.go`），后端每次重启后已签发 JWT 全部失效。
- `?token=` 会让 JWT 出现在 URL、日志与 Referer 中；生产环境请勿公开后端日志，必要时在 `config.json` 的 `privacy_regs` 追加 `token=` 脱敏。

---

## 分片上传（默认开启，每片 50MB）

Go 后端原生提供 `/api/fs/multipart/{init,chunk,complete,status,abort}`。本项目把
`multipart_enabled=true`、`multipart_chunk_size=50`（MB）**固化进源码默认值**
（见 [`backend-openlist/patches/multipart-chunk-50.patch`](./backend-openlist/patches/multipart-chunk-50.patch)，
由 `build.sh` 的 2.6 段幂等应用），因此**重建后端或清空数据后无需管理员手动设置即自动生效**；
运行中实例也已通过 `POST /api/admin/setting/save` 即时设为 50。二者都是 PUBLIC 设置，
管理页 **设置 → 流量** 仍可随时调整。前端 `src/pages/home/uploads/uploads.ts` 的默认上传器
即 `Multipart`，片大小按后端返回值计算，**无需改前端代码**。

- 文件 ≤ `multipart_chunk_size`、或 `init` 返回 `data:null`（驱动不支持会话分片）时自动回退 `StreamUpload`
  （1 次请求更快）。即 ≤50MB 走流式，>50MB 才按 50MB 分片，属官方优化。
- 上传对话框**不要勾选 sidecars**，否则 `effectiveUploader()` 会强制切到 Stream。
- **实测（2026-11-07）**：CloudStudio 网关**只覆盖 `Authorization` 头**，其余自定义头
  （`File-Path` / `X-Upload-Id` / `X-Chunk-Index` / `X-File-Size` / `X-Chunk-Size` / `Overwrite` 等）
  与 query 参数全部可靠透传 → 原生 multipart 协议可直接使用，**无需** query→Header 还原补丁。
- 端到端实测：11 MB 文件（10 MB + 1 MB 两片）、以及调成 50MB 后的 60 MB 文件
  （`init` 回显 `chunk_size=52428800`，50 MB + 10 MB 两片）经网关 `init → chunk×2 → complete`
  全部 `200`，落地文件大小与 **sha256 完全一致**；`abort`、状态查询、重传路径亦正常。
  后端对每片长度有严格校验（少发会返回 `incomplete chunk ... EOF` 并拒绝 `complete`）。
  **50MB 单片经网关 PUT 返回 200**，说明网关可透传 50MB 请求体，无需降级片大小。
- 每个活跃会话服务端最多在磁盘缓冲 8 个分片（50MB × 8 = 400MB），并发大文件上传时需留足后端磁盘余量。
- 若更换到有请求体大小上限的 CDN/网关，只需调小 `multipart_chunk_size`，前端会自动按后端返回值重新分片。

---

## 多语言（简体中文等 23 种）

官方前端源码树**只保留 `en`**，其他语言由发版流程用 Crowdin 注入到构建产物；
Vercel 从 GitHub 源码构建时拿不到这些注入文件，因此线上曾只有英文。

修复方式：从官方 npm 包 `@openlist-frontend/openlist-frontend@4.2.9` 的
`dist/i18n.tar.gz`（可经 jsDelivr CDN 直接取，无需整包下载）解出全部 **23 种语言**放入
`src/lang/`，并**移除 `frontend/.gitignore` 里官方的 `/src/lang/*` 忽略规则**——否则语言包不入库，
Vercel 构建时仍只有 en。`src/app/i18n.ts` 用 `import.meta.glob("~/lang/*/index.json")`
自动发现语言，新增目录即自动出现在语言菜单，并为每种语言生成独立 lazy chunk。
`zh-CN` 覆盖率约 96%，缺失键回退英文。

默认语言逻辑同步修正（`i18n.ts` / `SwitchLanguage.tsx`）：

- 中文浏览器首次访问**自动中文**；
- 旧版写入的 `lang=en` 会**自动迁移到中文**（用 `lang_explicit` 标记区分，避免覆盖用户主动选择）；
- 用户显式选过的语言保持不变，英文浏览器仍为英文。

---

## 挂载其他网盘（原生能力）

管理页 **存储 → 添加**，从 90+ 驱动中选择（本地存储、对象存储、OneDrive、115、阿里云盘、
WebDAV、S3、SMB、FTP…）。使用官方**完整版**二进制 / 编译产物（非 lite，lite 只影响内嵌前端资源）。
编译产物由 `cmd/root.go` 的 `_ "github.com/OpenListTeam/OpenList/v4/drivers"` 全量导入所有驱动。

---

## Vercel 部署与配置注入

`frontend/vercel.json`：

```json
{
  "framework": "vite",
  "installCommand": "pnpm install",
  "buildCommand": "pnpm build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

在 Vercel 项目环境变量设置（与 `frontend/.env.production` 同值）：

```
VITE_API_URL = https://<后端域名>.app.workbuddy.host
```

- **不带尾斜杠、不带 `/api`**（`request.ts` 会拼 `/api`）。
- **绝不能写 `"/"`**：`config.ts` 里 `api === "/"` 会回退到 `location.origin`，请求错发到 Vercel 自己。
- `index.html` 中 `window.OPENLIST_CONFIG.cdn` 与 `window.__dynamic_base__` **必须保持空字符串**，
  绝不能设成 `"/"`——会拼出 `//assets/x.js` 协议相对 URL 导致白屏。
- `index.html` 的 `window.OPENLIST_CONFIG.api` 保持 `undefined`，作为部署期可覆盖的注入点。
- 语言包随源码入库，Vercel 构建时会为 23 种语言各生成 lazy chunk；**不要**在 Vercel 上依赖
  官方的 Crowdin 注入流程（本项目未接入）。

---

## 本地开发

```bash
# 后端（Go，监听 8000）
cd /workspace/netdisk
# 首次（无 admin）用环境变量创建，不能先 admin set
OPENLIST_ADMIN_PASSWORD='<密码>' ./openlist server --data /workspace/netdisk/openlist-data
# 之后正常启动：
# ./openlist server --data /workspace/netdisk/openlist-data

# 前端（走同源 dev proxy 到 :8000）
cd frontend
pnpm install
DEV_PROXY_TARGET=http://127.0.0.1:8000 pnpm dev
```

`config.json` 关键字段（`<data>/config.json`）：

```json
{
  "force_https": false,
  "site_url": "https://<后端域名>.app.workbuddy.host",
  "scheme": { "address": "0.0.0.0", "http_port": 8000, "https_port": -1 },
  "cors": { "allow_origins": ["*"], "allow_methods": ["*"], "allow_headers": ["*"] },
  "dist_dir": "<占位目录>/public/dist"
}
```

- `http_port` 必须为 **8000**（平台网关固定暴露该端口）。
- `site_url` **不要带子路径**，否则 `conf.URL.Path` 会给所有 API 路径加一层前缀。
- `dist_dir` 指向占位目录即可跳过内嵌前端（前后端分离，前端由 Vercel 提供）。

---

## 升级复用

`backend-openlist/build.sh` 会对指定版本的 Go 源码重新打补丁并编译：

```bash
bash backend-openlist/build.sh v4.2.9     # 省略版本默认 v4.2.9
```

脚本幂等，依次应用：

1. `?token=` query 优先鉴权补丁 → `server/middlewares/auth.go` 的 `Auth` / `Authn`（及可选 `LogOut`）；
2. 分片默认值 → `internal/bootstrap/data/setting.go` 的 `multipart_chunk_size` 10MB→50MB，
   以及 `server/handles/multipart.go` 的 fallback 值（见 `patches/multipart-chunk-50.patch`）；
3. 生成 `public/dist/index.html` 占位（前后端分离时 `initIndex()` 仍要求该文件存在）。

编译需要 Go ≥ `go.mod` 要求（v4.2.9 为 `go 1.26.0` / `toolchain go1.27.3`）与 gcc（CGO，sqlite 驱动）。
沙箱内 `proxy.golang.org` 不可达，脚本默认使用 `mirrors.tencent.com/go` + `goproxy.cn` 镜像；
`GOROOT` 必须显式指向新工具链（环境里被写死成 `/usr/local/go` 的旧版本）。

---

## 历史

`backend/app.py`（Flask）与旧 React 前端是本项目早期实现，现已停用，仅保留在 git 历史与
切换前的备份快照中。当前后端改用 OpenList 官方 Go 实现后，之前自研的分享 / 元信息 /
访客 / WebDAV / 兼容层均由 OpenList 原生能力取代。
