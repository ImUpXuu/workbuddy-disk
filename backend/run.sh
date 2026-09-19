#!/usr/bin/env bash
# 网盘服务管理脚本
# 用法: NETDISK_KEY=<访问密钥> ./run.sh start|stop|restart|status
#
# NETDISK_KEY 是必填的访问密钥（无默认值）。可写入同目录的 .env 再 source。

DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.app.pid"
LOGFILE="$DIR/app.log"
PORT="${PORT:-8000}"

start() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "已在运行 (PID=$(cat "$PIDFILE"))"
        return 0
    fi

    # 访问密钥是必填项，缺失就早失败，别让服务起来后才发现登不进去
    if [ -z "$NETDISK_KEY" ]; then
        if [ -f "$DIR/.env" ]; then
            # shellcheck disable=SC1091
            . "$DIR/.env"
        fi
    fi
    if [ -z "$NETDISK_KEY" ]; then
        echo "错误：未设置 NETDISK_KEY（访问密钥）。" >&2
        echo '生成一个：python3 -c "import secrets; print(secrets.token_urlsafe(24))"' >&2
        echo "用法示例：NETDISK_KEY=<你的密钥> $0 start" >&2
        return 1
    fi

    cd "$DIR" || exit 1
    PORT="$PORT" NETDISK_KEY="$NETDISK_KEY" nohup python3 app.py >>"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "已启动 (PID=$(cat "$PIDFILE"), 端口=$PORT)"
    else
        echo "启动失败，详见 $LOGFILE"
        tail -20 "$LOGFILE"
        return 1
    fi
}

stop() {
    if [ -f "$PIDFILE" ]; then
        PID="$(cat "$PIDFILE")"
        kill "$PID" 2>/dev/null
        sleep 1
        kill -9 "$PID" 2>/dev/null
        rm -f "$PIDFILE"
        echo "已停止 (PID=$PID)"
    else
        echo "未在运行"
    fi
}

status() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "运行中 (PID=$(cat "$PIDFILE"), 端口=$PORT)"
        curl -s -o /dev/null -w "HTTP 探测: %{http_code}\n" "http://127.0.0.1:$PORT/"
    else
        echo "未运行"
    fi
}

case "$1" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; start ;;
    status)  status ;;
    *)       echo "用法: $0 start|stop|restart|status" ;;
esac
