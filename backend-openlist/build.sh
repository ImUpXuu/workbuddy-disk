#!/usr/bin/env bash
# 一键重建 OpenList Go 后端（含 ?token= 网关兼容补丁）
# 用法：bash backend-openlist/build.sh [版本，默认 v4.2.9]
#
# 背景：CloudStudio 网关会把 Authorization 请求头覆盖成它自己的失效 token，
# 只有 query 参数能可靠透传。官方 Go 后端 Auth/Authn 只读 Header，故定制了
# server/middlewares/auth.go（files/auth.go）：?token= 优先 + 脏头降级为游客。
# 前端 request.ts 拦截器会把 localStorage.token 注入 config.params.token
# （未登录时注入空串，显式声明游客身份）。
set -euo pipefail

VER="${1:-v4.2.9}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC=/workspace/openlist-go
RUN=/workspace/netdisk
OUT="$RUN/openlist"

# Go 工具链：优先用本仓库装好的 go-new，否则回退到系统 go（需 >= go.mod 要求）
GO_BIN=/workspace/go-new/bin
if [ -x "$GO_BIN/go" ]; then
  export PATH="$GO_BIN:$PATH"
  # 环境里 GOROOT 被写死成 /usr/local/go(go1.21.4)，会让新版 go 去读旧标准库
  # 而报 "package iter/weak/... is not in std"，必须显式覆盖到新工具链目录。
  export GOROOT=/workspace/go-new
  export GOTOOLCHAIN=local
else
  export GOTOOLCHAIN=auto
fi
export CGO_ENABLED=1
# 沙箱内 proxy.golang.org 不可达（zip 下载 i/o timeout），必须用可达镜像：
# 腾讯镜像为环境默认，goproxy.cn 兜底，direct 最后。GOPROXY 允许用逗号列多个。
export GOPROXY="${GOPROXY:-https://mirrors.tencent.com/go/,https://goproxy.cn,direct}"

echo "==> Go 版本：$(go version)"

# 1) 源码（按版本；已存在则复用，避免重复下载）
mkdir -p "$SRC"
cd "$SRC"
if [ ! -f go.mod ]; then
  echo "==> 下载 OpenList 源码 $VER"
  curl -fL --retry 3 -o /workspace/openlist-src.tar.gz \
    "https://codeload.github.com/OpenListTeam/OpenList/tar.gz/refs/tags/${VER}"
  tar -xzf /workspace/openlist-src.tar.gz -C "$SRC" --strip-components=1
fi

# 2) 鉴权中间件：用仓库内定制版整体覆盖（幂等）
#    - ?token= 优先覆盖 Header（网关会塞失效 Authorization，query 才可信）
#    - query 中出现 token 键（含空串）即视为客户端显式声明，空串 = 游客
#    - Header/token 解析失败且 guest 可用时降级游客，避免游客被 401 弹去登录页
#    旧版 inline patch 已废弃；差异留档在 patches/token-from-query.patch 与
#    patches/guest-fallback.patch。
AUTH="$SRC/server/middlewares/auth.go"
AUTH_SRC="$REPO/backend-openlist/files/auth.go"
if [ -f "$AUTH_SRC" ]; then
  [ -f "$AUTH.orig" ] || cp "$AUTH" "$AUTH.orig"
  cp "$AUTH_SRC" "$AUTH"
  echo "==> 已安装定制鉴权中间件（?token= 优先 + guest 降级）"
else
  echo "!! 缺少 $AUTH_SRC" >&2
  exit 1
fi

# LogOut 同样兼容（可选，写法不同则跳过）
LOGOUT="$SRC/server/handles/auth.go"
if [ -f "$LOGOUT" ] && ! grep -q 'c.Query("token")' "$LOGOUT"; then
  python3 - "$LOGOUT" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
old = 'err := common.InvalidateToken(c.GetHeader("Authorization"))'
new = 'tok := c.GetHeader("Authorization")\n\tif q := c.Query("token"); q != "" {\n\t\ttok = q\n\t}\n\terr := common.InvalidateToken(tok)'
if old in s:
    p.write_text(s.replace(old, new))
PY
fi

# 2.5) gofmt 规整补丁缩进（Auth 在闭包内需 2 层、Authn 需 1 层，统一交给 gofmt）
gofmt -w "$AUTH" "$LOGOUT" 2>/dev/null || true

# 2.6) 分片上传：默认开启 + 每片 50MB（固化进源码默认值，幂等）
#  官方默认 multipart_enabled=true / multipart_chunk_size=10。把片大小写进
#  InitialSettings 默认值，重建后端或清空数据后无需管理员手动设置即自动生效。
SETTING="$SRC/internal/bootstrap/data/setting.go"
MPH="$SRC/server/handles/multipart.go"
python3 - "$SETTING" "$MPH" <<'PY'
import sys
from pathlib import Path
s = Path(sys.argv[1]); c = s.read_text()
old = '{Key: conf.MultipartChunkSize, Value: "10"'
new = '{Key: conf.MultipartChunkSize, Value: "50"'
if old in c:
    s.write_text(c.replace(old, new, 1)); print("==> setting.go 默认片大小 10MB -> 50MB")
elif new not in c:
    sys.exit("!! setting.go 默认值未匹配（上游版本变化？）")
m = Path(sys.argv[2]); t = m.read_text()
old2 = 'setting.GetInt(conf.MultipartChunkSize, 10)'
new2 = 'setting.GetInt(conf.MultipartChunkSize, 50)'
if old2 in t:
    m.write_text(t.replace(old2, new2, 1)); print("==> multipart.go fallback 10MB -> 50MB")
elif new2 not in t:
    sys.exit("!! multipart.go fallback 未匹配（上游版本变化？）")
print("==> 分片默认值已固化为 enabled=true / 50MB")
PY

# 2.7) 服务器状态接口（新增 handler + admin 路由，幂等）
#  后台「服务器状态」面板的数据源：GET /api/admin/server/status
#  handler 源文件随仓库提供，编译时复制进源码并注册到 admin 路由组。
STATUS_SRC="$REPO/backend-openlist/files/server_status.go"
STATUS_DST="$SRC/server/handles/server_status.go"
if [ -f "$STATUS_SRC" ]; then
  cp "$STATUS_SRC" "$STATUS_DST"
  echo "==> 已安装 server_status.go"
else
  echo "!! 缺少 $STATUS_SRC，跳过状态接口" >&2
fi
ROUTER="$SRC/server/router.go"
if [ -f "$STATUS_DST" ] && ! grep -q 'handles.ServerStatus' "$ROUTER"; then
  python3 - "$ROUTER" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
anchor = "func admin(g *gin.RouterGroup) {\n"
assert anchor in s, "未找到 admin 路由组锚点"
s = s.replace(anchor, anchor + '\tg.GET("/server/status", handles.ServerStatus)\n', 1)
p.write_text(s); print("==> 已注册 /api/admin/server/status")
PY
fi
[ -f "$STATUS_DST" ] && gofmt -w "$STATUS_DST" "$ROUTER" 2>/dev/null || true

# 3) dist 占位：dist_dir 非空时 initIndex() 仍会 static.Open("index.html")，
#    缺 index.html 会 Fatal 退出，必须放一个最小 index.html（前后端分离，前端由 Vercel 提供）。
#    同时官方源码 public/dist 自带 README.md 供 //go:embed all:dist 用（缺则补）。
mkdir -p "$SRC/public/dist"
[ -f "$SRC/public/dist/README.md" ] || printf 'placeholder\n' > "$SRC/public/dist/README.md"
if [ ! -f "$SRC/public/dist/index.html" ]; then
  cat > "$SRC/public/dist/index.html" <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"><title>API only</title>
<script>window.OPENLIST_CONFIG={cdn: undefined, base_path: undefined, api: undefined, main_color: undefined};</script>
</head><body><p>Frontend is served by Vercel. This backend exposes /api only.</p></body></html>
HTML
fi

# 4) 编译（先写 .new 再原子替换：正在运行的 openlist 会占用二进制，
#    直接 -o 到 $OUT 会报 "text file busy"）
echo "==> go build（首次 90+ 驱动较慢）"
cd "$SRC"
go build -ldflags="-s -w" -tags=jsoniter -o "$OUT.new" .
chmod +x "$OUT.new"
mv -f "$OUT.new" "$OUT"
echo "==> 完成：$OUT（需重启后端进程才会加载新二进制）"
ls -lh "$OUT"
