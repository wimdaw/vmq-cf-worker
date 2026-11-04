// Package collect 负责把「本机发生了什么」翻译成 protocol.Report。
//
// 分层刻意做成「共享汇总 + 平台原子操作」：
//   - 本文件的逻辑三平台共用，负责口径统一、错误兜底、指标扁平化；
//   - 各平台文件只实现 GetCPU/GetMem/GetDisk/GetNet/GetProcs/OSVersion 这些
//     「只有该平台才知道怎么量」的原子操作。
//
// 这样新增一个平台只需要实现 6 个函数，规则、告警、上报全都不用动。
package collect

import (
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// AgentVersion 由构建时注入（-ldflags "-X ...AgentVersion=x.y.z"）。
var AgentVersion = "dev"

// memUsage 是各平台内存采集的统一中间结构。
// available 一律取「应用真能申请到」的量：Linux 用 MemAvailable，
// macOS 用 free+inactive+speculative，Windows 用 ullAvailPhys。
type memUsage struct {
	total, available uint64
	swapTotal        uint64
	swapUsed         uint64
}

// 网络速率需要前后两次采样，状态放进程内；首轮速率为 0。
type netSample struct {
	at     time.Time
	rx, tx uint64
}

var (
	netMu   sync.Mutex
	netLast *netSample
)

// Gather 采集一次全量快照。任何单项失败都记进 Errors 而不是中断整个采集 ——
// 监控程序自己因为「读不到某个磁盘」而退出，是最没价值的行为。
func Gather(cfg *config.Config) protocol.Report {
	start := time.Now()
	rep := protocol.Report{
		V:        protocol.Version,
		AgentID:  cfg.AgentID,
		Interval: cfg.IntervalSec,
		System:   protocol.System{},
		Business: protocol.Business{BaseURL: cfg.Server.BaseURL},
		Metrics:  protocol.Metrics{},
	}

	host, _ := os.Hostname()
	up, _ := uptime()
	rep.Host = protocol.Host{
		Name:         host,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		OSVersion:    osVersion(),
		UptimeSec:    int64(up.Seconds()),
		AgentVersion: AgentVersion,
		GoVersion:    runtime.Version(),
	}

	rep.System.CPU = collectCPU(&rep.Errors)
	rep.System.Mem = collectMem(&rep.Errors)

	for _, m := range cfg.Collect.Disks {
		d, err := diskUsage(m)
		if err != nil {
			rep.Errors = append(rep.Errors, "disk "+m+": "+err.Error())
			continue
		}
		rep.System.Disks = append(rep.System.Disks, d)
	}

	if cfg.Collect.Network == nil || *cfg.Collect.Network {
		rep.System.Net = collectNet(&rep.Errors)
	}

	if len(cfg.Collect.Processes) > 0 {
		procs, err := processList(cfg.Collect.Processes)
		if err != nil {
			rep.Errors = append(rep.Errors, "process: "+err.Error())
		}
		rep.System.Procs = procs
	}

	for _, p := range cfg.Collect.Ports {
		rep.System.Ports = append(rep.System.Ports, probePort(p))
	}

	rep.System.Extra = protocol.Extra{
		User:  currentUser(),
		Notes: platformNotes(),
	}

	// 业务侧：失败不阻断系统指标的产出
	rep.Business = collectBusiness(cfg, &rep.Errors)

	rep.Metrics = flatten(rep)

	rep.System.Extra.CollectMs = time.Since(start).Milliseconds()
	rep.TS = time.Now().Unix()
	return rep
}

func collectCPU(errs *[]string) protocol.CPU {
	c := protocol.CPU{Cores: runtime.NumCPU()}

	// 使用率各平台自己采样，但**口径一致**：都是一段时间内的
	// (总时间 - 空闲时间) / 总时间。Windows/Linux 用累计计数器求差，
	// macOS 在 kern.cp_time 不可用时退回 iostat 的区间值。
	if pct, err := platformCPU(); err != nil {
		*errs = append(*errs, "cpu: "+err.Error())
	} else {
		if pct < 0 {
			pct = 0
		}
		if pct > 100 {
			pct = 100
		}
		c.UsagePct = round2(pct)
	}

	// load average 只有 Unix 有，Windows 明确留空而不是给 0 —— 给 0 会被误读成「没负载」
	if l1, l5, l15, ok := loadAvg(); ok {
		c.Load1, c.Load5, c.Load15 = &l1, &l5, &l15
	}
	return c
}

func collectMem(errs *[]string) protocol.Mem {
	m, err := memUsageOf()
	if err != nil {
		*errs = append(*errs, "mem: "+err.Error())
		return protocol.Mem{}
	}
	out := protocol.Mem{TotalBytes: m.total, AvailableBytes: m.available}
	if m.total > 0 {
		out.UsedPct = round2(float64(m.total-m.available) / float64(m.total) * 100)
	}
	if m.swapTotal > 0 {
		out.SwapTotalBytes = m.swapTotal
		out.SwapUsedPct = round2(float64(m.swapUsed) / float64(m.swapTotal) * 100)
	}
	return out
}

func collectNet(errs *[]string) *protocol.Net {
	rx, tx, err := netBytes()
	if err != nil {
		// 拿不到就省略，不编造 0 —— 0 会被规则误判成「网络断了」
		*errs = append(*errs, "net: "+err.Error())
		return nil
	}
	out := &protocol.Net{RxBytes: rx, TxBytes: tx}

	netMu.Lock()
	defer netMu.Unlock()
	now := time.Now()
	if netLast != nil && rx >= netLast.rx && tx >= netLast.tx {
		if secs := now.Sub(netLast.at).Seconds(); secs > 0 {
			out.RxRateBps = uint64(float64(rx-netLast.rx) / secs)
			out.TxRateBps = uint64(float64(tx-netLast.tx) / secs)
		}
	}
	netLast = &netSample{at: now, rx: rx, tx: tx}
	return out
}

// flatten 把结构化的采集结果压成一份扁平指标表。
// 规则引擎、告警文案、上报都只看这张表，保证「同一规则在三平台读到同一个数」。
func flatten(rep protocol.Report) protocol.Metrics {
	m := protocol.Metrics{}
	m[protocol.MetricCPUPct] = rep.System.CPU.UsagePct
	m[protocol.MetricMemPct] = rep.System.Mem.UsedPct
	m[protocol.MetricSwapPct] = rep.System.Mem.SwapUsedPct
	if rep.System.CPU.Load1 != nil {
		m[protocol.MetricLoad1] = *rep.System.CPU.Load1
	}

	worst := 0.0
	for _, d := range rep.System.Disks {
		if d.UsedPct > worst {
			worst = d.UsedPct
		}
	}
	m[protocol.MetricDiskPct] = worst

	missing := 0
	for _, p := range rep.System.Procs {
		if !p.Running {
			missing++
		}
	}
	m[protocol.MetricProcMissing] = float64(missing)

	down := 0
	for _, p := range rep.System.Ports {
		if !p.Reachable {
			down++
		}
	}
	m[protocol.MetricPortDown] = float64(down)

	b := rep.Business
	m[protocol.MetricServiceUp] = boolToFloat(b.Up)
	m[protocol.MetricHealthMs] = float64(b.HealthMs)
	m[protocol.MetricDBReady] = boolToFloat(b.DBReady)
	m[protocol.MetricMonitorOfflineSec] = float64(b.MonitorOfflineSec)
	m[protocol.MetricPassages] = float64(b.Passages)
	m[protocol.MetricPendingOrders] = float64(b.Orders["0"])
	m[protocol.MetricPaidOrders] = float64(b.Orders["1"])
	m[protocol.MetricNotifyFailed] = float64(b.Orders["2"])
	m[protocol.MetricExpiredOrders] = float64(b.Orders["3"])
	m[protocol.MetricTotalOrders] = float64(b.TotalOrders)
	return m
}

func boolToFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}
