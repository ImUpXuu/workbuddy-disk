#!/usr/bin/env bash
# 一键重建 OpenList Go 后端（含 ?token= 网关兼容补丁）
# 用法：bash backend-openlist/build.sh [版本，默认 v4.2.9]
#
# 背景：CloudStudio 网关会剥离 Authorization 请求头，但透传 query 参数。
# 官方 Go 后端 Auth/Authn 只读 Header，故打补丁让 token 也能从 ?token= 取。
# 前端 request.ts 拦截器会把 localStorage.token 注入 config.params.token。
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

# 2) ?token= 补丁（幂等）
AUTH="$SRC/server/middlewares/auth.go"
if ! grep -q 'c.Query("token")' "$AUTH"; then
  echo "==> 应用 ?token= 补丁"
  [ -f "$AUTH.orig" ] || cp "$AUTH" "$AUTH.orig"
  python3 - "$AUTH" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
# query 优先：网关会把 Authorization 头覆盖成失效 token，只有 query 能可靠透传，
# 因此 ?token= 有值就直接覆盖头（而不是仅当头为空才读）。
old = 'token := c.GetHeader("Authorization")'
new = old + '\n\tif q := c.Query("token"); q != "" {\n\t\ttoken = q\n\t}'
assert s.count(old) == 2, f"期望 2 处，实际 {s.count(old)}"
p.write_text(s.replace(old, new))
PY
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

# 4) 编译
echo "==> go build（首次 90+ 驱动较慢）"
cd "$SRC"
go build -ldflags="-s -w" -tags=jsoniter -o "$OUT" .
chmod +x "$OUT"
echo "==> 完成：$OUT"
ls -lh "$OUT"
