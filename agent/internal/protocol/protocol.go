// Package protocol 定义桌面监控端与 V免签 服务端之间的**唯一**数据契约。
//
// 三平台（Windows / macOS / Linux）采集到的结果最终都收敛成这里的 Report 结构，
// 平台差异只体现在字段是否有值（用 omitempty 表达），不体现在字段名或口径上。
// 服务端 src/routes/agent.ts 按同一份结构落库与展示，因此「三端功能一致」
// 不是靠约定，而是靠这份结构强制的。
package protocol

// Version 契约版本。字段只增不改；破坏性变更时递增，服务端按主版本号拒收。
const Version = "1"

// 报告里出现的告警级别。字符串而不是枚举，便于日志与前端直出。
const (
	LevelWarn = "warn"
	LevelCrit = "crit"
)

// Report 是一次完整采集的结果，也是上报的请求体。
type Report struct {
	V        string   `json:"v"`
	AgentID  string   `json:"agent_id"`
	Host     Host     `json:"host"`
	TS       int64    `json:"ts"`       // 采集完成时刻（unix 秒）
	Interval int      `json:"interval"` // 期望的采集间隔（秒），服务端据此判断数据是否过期
	System   System   `json:"system"`
	Business Business `json:"business"`
	Metrics  Metrics  `json:"metrics"`          // 规则引擎实际消费的扁平指标，同名同口径
	Wallet   *Wallet  `json:"wallet,omitempty"` // 到账事件源（账单轮询等）的运行状态
	Alerts   []Alert  `json:"alerts,omitempty"`
	Errors   []string `json:"errors,omitempty"` // 采集过程中的非致命错误，便于远程排查
}

// Wallet 是桌面端「直接确认到账」这条链路的运行状态。
//
// 手机端靠通知栏，桌面端靠账单轮询 —— 两条路产出的事件最终都走 /appPush，
// 但运维需要知道「桌面这条链路到底跑没跑起来」，所以单独报一段。
type Wallet struct {
	Enabled     bool     `json:"enabled"`
	Sources     []string `json:"sources,omitempty"`
	PushedTotal int64    `json:"pushed_total"` // 启动以来成功上报的条数
	LastEventTS int64    `json:"last_event_ts,omitempty"`
	LastMoney   string   `json:"last_money,omitempty"`
	LastMsg     string   `json:"last_msg,omitempty"` // 服务端返回的 msg，例如「无匹配订单，已记录」
	LastError   string   `json:"last_error,omitempty"`
	LastPollTS  int64    `json:"last_poll_ts,omitempty"`
}

// Host 是这台机器的身份信息。三个平台都必须填满。
type Host struct {
	Name         string `json:"name"`
	OS           string `json:"os"` // runtime.GOOS：windows / darwin / linux
	Arch         string `json:"arch"`
	OSVersion    string `json:"os_version"` // Windows 10.0.22631 / macOS 15.1 / Linux 6.8.0-45
	UptimeSec    int64  `json:"uptime_sec"`
	AgentVersion string `json:"agent_version"`
	GoVersion    string `json:"go_version"`
}

// System 是主机侧的运行状态。
type System struct {
	CPU   CPU    `json:"cpu"`
	Mem   Mem    `json:"mem"`
	Disks []Disk `json:"disks,omitempty"`
	Net   *Net   `json:"net,omitempty"` // 拿不到计数器时省略（例如 Windows 上 PowerShell 不可用）
	Procs []Proc `json:"procs,omitempty"`
	Ports []Port `json:"ports,omitempty"`
	Extra Extra  `json:"extra"` // 平台特有但值得一看的补充项
}

// CPU 使用率的采集方式三平台统一：读取「累计 CPU 时间片」两次采样求差，
// 而不是读厂商的性能计数器 —— 这样三个数字天然可比。
type CPU struct {
	UsagePct float64 `json:"usage_pct"`
	Cores    int     `json:"cores"`
	// 以下仅 Unix 有（Windows 没有 load average 概念），用指针表达「不适用」
	Load1  *float64 `json:"load1,omitempty"`
	Load5  *float64 `json:"load5,omitempty"`
	Load15 *float64 `json:"load15,omitempty"`
}

// Mem 的 used 口径统一为 total - available，available 取各平台「应用可直接申请到」的量，
// 而不是简单的 free —— macOS 的 free 会被缓存压到接近 0，直接看 free 会误判。
type Mem struct {
	TotalBytes     uint64  `json:"total_bytes"`
	AvailableBytes uint64  `json:"available_bytes"`
	UsedPct        float64 `json:"used_pct"`
	SwapTotalBytes uint64  `json:"swap_total_bytes,omitempty"`
	SwapUsedPct    float64 `json:"swap_used_pct,omitempty"`
}

type Disk struct {
	Mount      string  `json:"mount"`
	TotalBytes uint64  `json:"total_bytes"`
	FreeBytes  uint64  `json:"free_bytes"`
	UsedPct    float64 `json:"used_pct"`
}

// Net 是累计字节数与最近一个间隔的速率。速率由进程内前后两次采样算得，
// 首次采集时速率为 0。
type Net struct {
	RxBytes   uint64 `json:"rx_bytes"`
	TxBytes   uint64 `json:"tx_bytes"`
	RxRateBps uint64 `json:"rx_rate_bps"`
	TxRateBps uint64 `json:"tx_rate_bps"`
}

// Proc 只报告「被点名关注」的进程（支付客户端、服务进程），不做全量进程快照 ——
// 全量快照在 Windows 上开销大，且对定位问题没有额外价值。
type Proc struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
	Count   int    `json:"count"`
	PIDs    []int  `json:"pids,omitempty"`
}

type Port struct {
	Name      string `json:"name"`
	Addr      string `json:"addr"`
	Reachable bool   `json:"reachable"`
	LatencyMs int64  `json:"latency_ms,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Extra 放「平台特有但排障有用」的字段，键名不做契约约束。
type Extra struct {
	// Windows：是否以服务身份运行；Unix：有效用户
	User string `json:"user,omitempty"`
	// 采集耗时，能侧面反映机器是否已经卡了
	CollectMs int64 `json:"collect_ms"`
	// 平台命令降级说明，例如 netstat 不可用时的原因
	Notes []string `json:"notes,omitempty"`
}

// Business 是支付业务侧的运行状态，全部来自服务端已有的只读接口
// （/api/health 与 /api/stats），不新增隐私面。
type Business struct {
	BaseURL string `json:"base_url"`

	// 服务可达性
	Up         bool   `json:"up"`
	HealthMs   int64  `json:"health_ms"`
	HealthCode int    `json:"health_code,omitempty"`
	Error      string `json:"error,omitempty"`

	// /api/stats 的核心字段（字段名与服务端 Stats 保持一致，便于对照排查）
	DBReady  bool  `json:"db_ready"`
	ServerTS int64 `json:"server_ts"`

	MonitorLastHeart int64 `json:"monitor_last_heart"`
	MonitorLastPay   int64 `json:"monitor_last_pay"`
	MonitorOnline    bool  `json:"monitor_online"`
	// 监控端（手机 App / 桌面端）已离线多少秒；服务端说在线时为 0
	MonitorOfflineSec int64 `json:"monitor_offline_sec"`

	Passages    int            `json:"passages"`
	Orders      map[string]int `json:"orders"` // 0 待支付 / 1 已支付 / 2 回调失败 / 3 已过期
	TotalOrders int            `json:"total_orders"`
}

// Metrics 是规则引擎与告警实际读的扁平数字。键名跨平台固定：
// 平台适配层只负责把「本机怎么量」翻译成这里的同一个键。
type Metrics map[string]float64

// 规则会引用的指标键，集中在这里定义，避免各平台拼错字符串。
const (
	MetricCPUPct            = "cpu_pct"
	MetricMemPct            = "mem_pct"
	MetricSwapPct           = "swap_pct"
	MetricDiskPct           = "disk_pct" // 取所有受监控挂载点里最满的那个
	MetricLoad1             = "load1"
	MetricProcMissing       = "proc_missing" // 点名的进程里没在跑的个数
	MetricPortDown          = "port_down"    // 点名的端口里连不上的个数
	MetricServiceUp         = "service_up"   // 1/0
	MetricHealthMs          = "health_latency_ms"
	MetricDBReady           = "db_ready" // 1/0
	MetricMonitorOfflineSec = "monitor_offline_sec"
	MetricPassages          = "passages"
	MetricPendingOrders     = "pending_orders" // orders["0"]
	MetricPaidOrders        = "paid_orders"    // orders["1"]
	MetricNotifyFailed      = "notify_failed"  // orders["2"]
	MetricExpiredOrders     = "expired_orders" // orders["3"]
	MetricTotalOrders       = "total_orders"
)

// Alert 是一条已经过状态机判定的告警（或恢复通知）。
type Alert struct {
	Rule      string  `json:"rule"`
	Metric    string  `json:"metric"`
	Level     string  `json:"level"`
	Value     float64 `json:"value"`
	Threshold float64 `json:"threshold"`
	Message   string  `json:"message"`
	TS        int64   `json:"ts"`
	Recovered bool    `json:"recovered,omitempty"`
}
