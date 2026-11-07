import {
  Badge,
  Box,
  Button,
  Heading,
  HStack,
  Progress,
  ProgressIndicator,
  SimpleGrid,
  Text,
  VStack,
} from "@hope-ui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useManageTitle, useT } from "~/hooks"
import { handleResp, r } from "~/utils"
import type { Resp } from "~/types"

interface ServerStatus {
  server_time: string
  uptime_seconds: number
  host_uptime_seconds: number
  hostname: string
  os: string
  kernel: string
  arch: string
  version: string
  built_at: string
  web_version: string
  go_version: string
  cpu_percent: number
  cpu_cores: number
  num_goroutine: number
  go_mem_alloc: number
  go_mem_sys: number
  go_mem_heap: number
  mem_total: number
  mem_used: number
  mem_percent: number
  disk_path: string
  disk_total: number
  disk_used: number
  disk_free: number
  disk_percent: number
  site_title: string
  site_url: string
  http_port: number
  gateway_host: string
  storage_count: number
  multipart_enabled: boolean
  multipart_chunk_size: number
  multipart_inflight: number
  multipart_window_slots: number
}

const fmtBytes = (n?: number) => {
  if (!n || n < 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const fmtDuration = (s?: number) => {
  if (!s || s < 0) return "—"
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const parts: string[] = []
  if (d) parts.push(`${d} 天`)
  if (h) parts.push(`${h} 时`)
  if (m) parts.push(`${m} 分`)
  parts.push(`${sec} 秒`)
  return parts.join(" ")
}

const pct = (n?: number) => Math.min(100, Math.max(0, Math.round(n ?? 0)))

const Card = (props: { title: string; children: any }) => (
  <Box
    p="$4"
    bg="$neutral2"
    rounded="$lg"
    border="1px solid $neutral6"
    shadow="$sm"
  >
    <Heading size="sm" mb="$3" color="$neutral12">
      {props.title}
    </Heading>
    {props.children}
  </Box>
)

const Row = (props: { label: string; value: string; mono?: boolean }) => (
  <HStack justifyContent="space-between" py="$1" spacing="$3">
    <Text color="$neutral11" fontSize="$sm" whiteSpace="nowrap">
      {props.label}
    </Text>
    <Text
      color="$neutral12"
      fontSize="$sm"
      textAlign="right"
      css={{ wordBreak: "break-all", fontFamily: props.mono ? "monospace" : undefined }}
    >
      {props.value}
    </Text>
  </HStack>
)

const UsageBar = (props: {
  label: string
  percent: number
  detail: string
}) => {
  const scheme = () =>
    props.percent >= 90 ? "$danger6" : props.percent >= 70 ? "$warning6" : "$success6"
  return (
    <Box mb="$1">
      <HStack justifyContent="space-between" mb="$1_5">
        <Text fontWeight="$medium" color="$neutral12" fontSize="$sm">
          {props.label}
        </Text>
        <Text fontSize="$sm" color="$neutral11">
          {props.percent.toFixed(1)}%
        </Text>
      </HStack>
      <Progress
        value={props.percent}
        size="md"
        trackColor="$neutral5"
        rounded="$full"
      >
        <ProgressIndicator color={scheme()} rounded="$full" />
      </Progress>
      <Text fontSize="$xs" color="$neutral10" mt="$1">
        {props.detail}
      </Text>
    </Box>
  )
}

const ServerStatus = () => {
  const t = useT()
  useManageTitle("manage.sidemenu.server_status")

  const [status, setStatus] = createSignal<ServerStatus>()
  const [loading, setLoading] = createSignal(false)
  const [autoRefresh, setAutoRefresh] = createSignal(true)
  const [lastUpdate, setLastUpdate] = createSignal("")
  const [error, setError] = createSignal("")
  const [benching, setBenching] = createSignal(false)
  const [bench, setBench] = createSignal<{ mbps: number; sec: number } | null>(null)
  const [benchErr, setBenchErr] = createSignal("")

  let timer: ReturnType<typeof setInterval> | undefined

  const load = async () => {
    setLoading(true)
    try {
      const resp = (await r.get("/admin/server/status")) as Resp<ServerStatus>
      handleResp(
        resp,
        (data) => {
          setStatus(data)
          setError("")
          setLastUpdate(new Date().toLocaleTimeString())
        },
        (msg) => setError(msg),
        true,
        false,
      )
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  // 「经网关测速」：真实走前端 → CloudStudio 网关 → 后端链路上传一个
  // 临时文件并计时，直观反映当前大文件上传的实际吞吐（不是本地直连）。
  const speedTest = async () => {
    if (benching()) return
    setBenching(true)
    setBench(null)
    setBenchErr("")
    const size = 8 * 1024 * 1024
    const buf = new Uint8Array(size)
    for (let i = 0; i < size; i += 4096) buf[i] = i & 0xff
    const name = `.status-speedtest-${Date.now()}.bin`
    const t0 = performance.now()
    try {
      const resp = (await r.put("/fs/put", buf, {
        headers: {
          "Content-Type": "application/octet-stream",
          "File-Path": encodeURIComponent(`/${name}`),
        },
      })) as Resp<unknown>
      const sec = (performance.now() - t0) / 1000
      if (resp?.code === 200) {
        setBench({ mbps: size / 1048576 / sec, sec })
      } else {
        setBenchErr(resp?.message || `code=${resp?.code}`)
      }
      // 尽力清理临时文件，失败不影响测速结果
      try {
        await r.post("/fs/remove", { dir: "/", names: [name] })
      } catch (_) {
        /* ignore */
      }
    } catch (e: any) {
      setBenchErr(e?.message || String(e))
    } finally {
      setBenching(false)
    }
  }

  onMount(() => {
    load()
    timer = setInterval(() => {
      if (autoRefresh()) load()
    }, 5000)
  })
  onCleanup(() => timer && clearInterval(timer))

  const s = () => status()

  return (
    <VStack alignItems="stretch" spacing="$4" p="$2">
      <HStack justifyContent="space-between" flexWrap="wrap" spacing="$3">
        <VStack alignItems="flex-start" spacing="$0_5">
          <Heading size="lg">
            {t("manage.status.title", undefined, "服务器状态")}
          </Heading>
          <Text fontSize="$sm" color="$neutral11">
            {t(
              "manage.status.subtitle",
              undefined,
              "进程运行时 · 系统资源 · 网关与上传链路（每 5 秒自动刷新）",
            )}
          </Text>
        </VStack>
        <HStack spacing="$2" flexWrap="wrap">
          <Show when={s()}>
            <Badge colorScheme="success">
              {t("manage.status.online", undefined, "运行正常")}
            </Badge>
          </Show>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoRefresh(!autoRefresh())}
          >
            {autoRefresh()
              ? t("manage.status.auto_on", undefined, "自动刷新：开")
              : t("manage.status.auto_off", undefined, "自动刷新：关")}
          </Button>
          <Button size="sm" loading={loading()} onClick={load}>
            {t("manage.status.refresh", undefined, "刷新")}
          </Button>
        </HStack>
      </HStack>

      <Show when={error()}>
        <Box p="$3" rounded="$md" bg="$danger3" color="$danger11">
          <Text fontSize="$sm">
            {t("manage.status.load_failed", undefined, "状态获取失败")}：{error()}
          </Text>
        </Box>
      </Show>

      <Show when={!s() && !error()}>
        <Box p="$6" textAlign="center" color="$neutral11">
          <Text>{t("manage.status.loading", undefined, "正在加载服务器状态…")}</Text>
        </Box>
      </Show>

      <Show when={s()}>
        <SimpleGrid columns={{ "@initial": 1, "@md": 2, "@lg": 3 }} gap="$4">
          {/* 资源占用 */}
          <Card title={t("manage.status.resources", undefined, "资源占用")}>
            <UsageBar
              label="CPU"
              percent={pct(s()!.cpu_percent)}
              detail={`${s()!.cpu_cores} 核 · ${s()!.num_goroutine} 协程`}
            />
            <UsageBar
              label={t("manage.status.memory", undefined, "内存")}
              percent={pct(s()!.mem_percent)}
              detail={`${fmtBytes(s()!.mem_used)} / ${fmtBytes(s()!.mem_total)}`}
            />
            <UsageBar
              label={t("manage.status.disk", undefined, "磁盘")}
              percent={pct(s()!.disk_percent)}
              detail={`${fmtBytes(s()!.disk_used)} / ${fmtBytes(s()!.disk_total)} · 可用 ${fmtBytes(s()!.disk_free)}`}
            />
            <Text fontSize="$xs" color="$neutral10" mt="$2">
              {t("manage.status.disk_path", undefined, "统计路径")}：{s()!.disk_path}
            </Text>
          </Card>

          {/* 运行时 */}
          <Card title={t("manage.status.runtime", undefined, "运行时")}>
            <Row label={t("manage.status.version", undefined, "后端版本")} value={s()!.version} mono />
            <Row label="Go" value={s()!.go_version} mono />
            <Row label={t("manage.status.uptime", undefined, "服务已运行")} value={fmtDuration(s()!.uptime_seconds)} />
            <Row label={t("manage.status.host_uptime", undefined, "主机已运行")} value={fmtDuration(s()!.host_uptime_seconds)} />
            <Row label={t("manage.status.os", undefined, "系统 / 架构")} value={`${s()!.os} / ${s()!.arch}`} />
            <Row label={t("manage.status.hostname", undefined, "主机名")} value={s()!.hostname} mono />
            <Row label={t("manage.status.go_heap", undefined, "Go 堆内存")} value={fmtBytes(s()!.go_mem_heap)} />
            <Row label={t("manage.status.go_sys", undefined, "Go 占用")} value={fmtBytes(s()!.go_mem_sys)} />
            <Row label={t("manage.status.server_time", undefined, "服务器时间")} value={s()!.server_time} />
          </Card>

          {/* 网关与部署 */}
          <Card title={t("manage.status.gateway", undefined, "网关与部署（实际链路）")}>
            <Row label={t("manage.status.gateway_host", undefined, "当前网关域名")} value={s()!.gateway_host} mono />
            <Row label={t("manage.status.site_title", undefined, "站点名称")} value={s()!.site_title} />
            <Row label={t("manage.status.site_url", undefined, "站点 URL")} value={s()!.site_url} mono />
            <Row label={t("manage.status.http_port", undefined, "后端端口")} value={String(s()!.http_port)} />
            <Row label={t("manage.status.storages", undefined, "已挂载存储")} value={`${s()!.storage_count} 个`} />
            <Row label={t("manage.status.last_update", undefined, "本次刷新")} value={lastUpdate()} />
            <Text fontSize="$xs" color="$neutral10" mt="$2">
              {t(
                "manage.status.gateway_hint",
                undefined,
                "前端经 CloudStudio 网关直连后端；网关会覆盖 Authorization 头，鉴权走 ?token= 查询参数。",
              )}
            </Text>
          </Card>
        </SimpleGrid>

        {/* 上传链路 + 实测 */}
        <Card title={t("manage.status.upload", undefined, "上传链路与分片参数（大文件优化）")}>
          <SimpleGrid columns={{ "@initial": 1, "@md": 2 }} gap="$4">
            <Box>
              <Row
                label={t("manage.status.multipart", undefined, "分片上传")}
                value={s()!.multipart_enabled ? t("manage.status.enabled", undefined, "已开启") : t("manage.status.disabled", undefined, "已关闭")}
              />
              <Row label={t("manage.status.chunk_size", undefined, "每片大小")} value={`${s()!.multipart_chunk_size} MB`} />
              <Row label={t("manage.status.inflight", undefined, "前端上传并发")} value={`${s()!.multipart_inflight} 片`} />
              <Row label={t("manage.status.window", undefined, "后端接收窗口")} value={`${s()!.multipart_window_slots} 片`} />
              <Text fontSize="$xs" color="$neutral10" mt="$2">
                {t(
                  "manage.status.upload_hint",
                  undefined,
                  "网关按连接/流限速：单连接约 1.7 MB/s。并发 8 片实测 400MB 由 3.78 提升至 10.23 MB/s（约 2.7 倍）。网关为 HTTP/2，浏览器内并发同样有效。",
                )}
              </Text>
            </Box>
            <VStack alignItems="stretch" spacing="$2" justifyContent="center">
              <Button
                colorScheme="info"
                loading={benching()}
                onClick={speedTest}
              >
                {t("manage.status.speedtest", undefined, "经网关测速（8 MB）")}
              </Button>
              <Show when={bench()}>
                <Box p="$3" rounded="$md" bg="$info3" color="$info12">
                  <Text fontSize="$sm" fontWeight="$medium">
                    {t("manage.status.speedtest_result", undefined, "实测上传速率")}：
                    {bench()!.mbps.toFixed(2)} MB/s
                  </Text>
                  <Text fontSize="$xs">
                    {t("manage.status.speedtest_cost", undefined, "耗时")} {bench()!.sec.toFixed(2)} s ·
                    {t("manage.status.speedtest_note", undefined, "走真实网关链路，非本地直连")}
                  </Text>
                </Box>
              </Show>
              <Show when={benchErr()}>
                <Box p="$3" rounded="$md" bg="$danger3" color="$danger11">
                  <Text fontSize="$sm">
                    {t("manage.status.speedtest_failed", undefined, "测速失败")}：{benchErr()}
                  </Text>
                </Box>
              </Show>
              <Show when={!bench() && !benchErr() && !benching()}>
                <Text fontSize="$xs" color="$neutral10">
                  {t(
                    "manage.status.speedtest_hint",
                    undefined,
                    "点击按钮上传一个 8MB 临时文件并自动删除，测得当前经网关的单流上传吞吐。",
                  )}
                </Text>
              </Show>
            </VStack>
          </SimpleGrid>
        </Card>
      </Show>
    </VStack>
  )
}

export default ServerStatus
