// ServerStatus 状态接口 —— 由 backend-openlist/build.sh 复制到
// OpenList 源码 server/handles/server_status.go，并注册到 admin 路由组。
//
// 采集维度：进程运行时（版本/运行时长/协程/Go 内存）、系统资源（CPU/内存/磁盘）、
// 部署与上传链路（网关 Host、站点 URL、分片设置、并发度、存储挂载数）。
// 前端「服务器状态」面板通过 GET /api/admin/server/status?token= 拉取。
package handles

import (
	"runtime"
	"sync"
	"time"

	"github.com/OpenListTeam/OpenList/v4/internal/conf"
	"github.com/OpenListTeam/OpenList/v4/internal/op"
	"github.com/OpenListTeam/OpenList/v4/internal/setting"
	"github.com/OpenListTeam/OpenList/v4/server/common"
	"github.com/gin-gonic/gin"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

var (
	serverStartedAt  = time.Now()
	cachedCPUPercent float64
	cpuCacheMu       sync.RWMutex
)

// CPU 采样需要两次 /proc/stat 快照间隔，放到后台 goroutine 定时更新缓存，
// 避免每次打开状态面板都阻塞请求 ~1 秒。
func init() {
	go func() {
		for {
			if v, err := cpu.Percent(time.Second, false); err == nil && len(v) > 0 {
				cpuCacheMu.Lock()
				cachedCPUPercent = v[0]
				cpuCacheMu.Unlock()
			}
			time.Sleep(3 * time.Second)
		}
	}()
}

// ServerStatus 返回服务器运行状态（仅管理员可访问）。
func ServerStatus(c *gin.Context) {
	cpuCacheMu.RLock()
	cpuPct := cachedCPUPercent
	cpuCacheMu.RUnlock()
	cores, _ := cpu.Counts(true)

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	var memTotal, memUsed uint64
	var memPct float64
	if v, err := mem.VirtualMemory(); err == nil {
		memTotal, memUsed, memPct = v.Total, v.Used, v.UsedPercent
	}

	diskPath := conf.DataDir
	var diskTotal, diskUsed, diskFree uint64
	var diskPct float64
	if u, err := disk.Usage(diskPath); err == nil {
		diskTotal, diskUsed, diskFree, diskPct = u.Total, u.Used, u.Free, u.UsedPercent
	}

	hostname, platform, kernel := "", "", ""
	var hostUptime uint64
	if h, err := host.Info(); err == nil {
		hostname, platform, kernel, hostUptime = h.Hostname, h.Platform, h.KernelVersion, h.Uptime
	}

	siteURL := ""
	httpPort := 0
	if conf.Conf != nil {
		siteURL = conf.Conf.SiteURL
		httpPort = conf.Conf.Scheme.HttpPort
	}

	common.SuccessResp(c, gin.H{
		"server_time":         time.Now().Format("2006-01-02 15:04:05"),
		"uptime_seconds":      int64(time.Since(serverStartedAt).Seconds()),
		"host_uptime_seconds": hostUptime,
		"hostname":            hostname,
		"os":                  platform,
		"kernel":              kernel,
		"arch":                runtime.GOARCH,
		"version":             conf.Version,
		"built_at":            conf.BuiltAt,
		"web_version":         conf.WebVersion,
		"go_version":          runtime.Version(),
		"cpu_percent":         cpuPct,
		"cpu_cores":           cores,
		"num_goroutine":       runtime.NumGoroutine(),
		"go_mem_alloc":        ms.Alloc,
		"go_mem_sys":          ms.Sys,
		"go_mem_heap":         ms.HeapAlloc,

		"mem_total":   memTotal,
		"mem_used":    memUsed,
		"mem_percent": memPct,

		"disk_path":    diskPath,
		"disk_total":   diskTotal,
		"disk_used":    diskUsed,
		"disk_free":    diskFree,
		"disk_percent": diskPct,

		"site_title":  setting.GetStr(conf.SiteTitle, "OpenList"),
		"site_url":    siteURL,
		"http_port":   httpPort,
		"gateway_host": c.Request.Host,
		"storage_count": len(op.GetAllStorages()),

		"multipart_enabled":      setting.GetBool(conf.MultipartEnabled),
		"multipart_chunk_size":   setting.GetInt(conf.MultipartChunkSize, 50),
		"multipart_inflight":     8,
		"multipart_window_slots": 8,
	})
}
