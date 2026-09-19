# WorkBuddy Disk · 前端

> Vite + React 18 + TypeScript + Tailwind v4。部署在 **Vercel**，绑定域名 `pan.upxuu.com`。

后端在 [`../backend`](../backend)，与本目录**不同源**，所有请求都是跨域的。跨域细节见下文。

---

## 本地开发

```bash
pnpm install

# 指向后端
echo 'VITE_API_BASE=http://127.0.0.1:8000' > .env.local

pnpm dev      # http://localhost:5173
```

> ⚠️ `vite.config.ts` 里**刻意没有配 `server.proxy`**。
> 走代理会把跨域问题掩盖住，等部署到 Vercel 才暴露就晚了。
> 本地就让它真跨域，这样问题在开发阶段就能发现。

---

## 部署到 Vercel

| 配置项 | 值 |
| --- | --- |
| Root Directory | `frontend` |
| Framework Preset | Vite（自动识别） |
| Build Command | `pnpm build`（默认） |
| Output Directory | `dist`（默认） |
| 环境变量 | `VITE_API_BASE` = 你的后端地址 |

绑定自定义域名 `pan.upxuu.com` 后，**记得把这个域名加进后端的 CORS 白名单**：

```bash
# 后端侧
export NETDISK_CORS_ORIGINS='https://pan.upxuu.com,http://localhost:5173'
```

---

## 目录结构

```
src/
├── api/
│   └── client.ts          # API 客户端：凭证注入、错误分类、401 广播
├── components/
│   ├── FileBrowser.tsx    # 文件浏览器主体（导航/排序/多选/写操作）
│   ├── FileRow.tsx        # 单个文件行
│   ├── PreviewModal.tsx   # 预览弹窗（图/视频/音频/文本）
│   ├── PromptModal.tsx    # 输入弹窗（重命名 / 新建文件夹）
│   ├── ConfirmModal.tsx   # 确认弹窗（删除）
│   ├── ToastHost.tsx      # 全局提示渲染
│   └── ui.tsx             # 基础组件（按钮/输入/开关/模态框/进度条…）
├── context/
│   ├── AuthContext.tsx    # 凭证状态
│   └── ToastContext.tsx   # 提示队列
├── lib/
│   └── utils.ts           # 格式化、路径、文件类型判断
├── pages/
│   ├── LoginPage.tsx      # 登录 / 凭证配置
│   └── DiskPage.tsx       # 主界面
├── types/
│   └── api.ts             # 后端契约类型定义
└── index.css              # Tailwind 主题与基础样式
```

---

## 鉴权设计

前端与后端不同源，**Cookie 通道不可靠**（跨站 `SameSite=Lax` 不会被带上），
所以凭证一律走 `localStorage` + 请求头：

```
localStorage['netdisk.apikey'] = 'ndk_xxx_yyy'   →  X-API-Key: ndk_xxx_yyy
localStorage['netdisk.token']  = '1790418793.sig' →  ?token=...
```

两条通道的优先级：

1. **API Key**（主通道）—— 有 key 就用 `X-API-Key` 头
2. **登录 token**（备选）—— 没有 key 时用 `?token=` 查询参数

`?token=` 走查询参数而非 `Authorization` 头，是因为部分反向网关会用自签 JWT
覆写 `Authorization`，用查询参数最稳。

> 任意请求收到 401，会通过 `onUnauthorized` 广播给 `AuthContext`，
> 自动清理失效凭证并回到登录页。不需要在每个调用点手动处理。

---

## 错误分类

`ApiError` 把失败分成 11 类，每类给人话提示。这是刻意做的 ——
浏览器出于安全考虑不会告诉 JS「请求是被 CORS 拦了还是网络断了」，
两者抛的都是 `TypeError`，所以只能靠 `navigator.onLine` 粗判，
至少给用户一个**有方向的**提示，而不是笼统的「请求失败」。

| kind | 场景 | 提示 |
| --- | --- | --- |
| `offline` | 网络不可达 | 连不上服务器，请检查网络或后端是否在运行 |
| `cors` | 跨域被拦 | 请求被跨域策略拦下，请确认后端已放行当前站点 |
| `unauthorized` | 401 | 凭证无效或已过期，请重新设置 API Key |
| `forbidden` | 403 | 区分「危险开关拦截」与其他权限问题 |
| `timeout` | 超时 | 请求超时，请重试 |

---

## 设计令牌

主题定义在 `index.css` 的 `@theme` 块，Tailwind v4 会自动生成对应工具类。

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--color-canvas` | `rgb(240,248,255)` | 页面底色 |
| `--color-brand-500` | `#0ea5e9` | 主色（天蓝） |
| `--radius-card` | `1.25rem` | 卡片圆角 |
| `--shadow-card` | 低对比大扩散 | 卡片阴影 |
| `--font-sans` | Nunito + 中文回退 | 正文 |

背景是 `radial-gradient` 圆点阵 + 顶部柔光，营造轻盈感。

---

## 脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` | 类型检查 + 生产构建 |
| `pnpm preview` | 预览构建产物 |
| `pnpm typecheck` | 仅类型检查 |
