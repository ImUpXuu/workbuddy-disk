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

完整参数与 `curl` 示例见 [`backend/API使用说明.md`](./backend/API使用说明.md)。

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
