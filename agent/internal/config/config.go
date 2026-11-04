// Package config 负责配置的加载、默认值与校验。
//
// 三平台共用**同一份 JSON 结构**，唯一差异是默认配置路径：
// Windows 走 ProgramData，macOS 走 /usr/local/etc，Linux 走 /etc。
// 这样同一份配置文件可以原样拷到任意平台使用，也方便用一套 Ansible/脚本下发。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/wallet"
)

// Rule 一条阈值规则。direction=above 表示「越大越糟」（CPU、磁盘），
// direction=below 表示「越小越糟」（服务存活、通道数）。
type Rule struct {
	Metric    string  `json:"metric"`
	Warn      float64 `json:"warn"`
	Crit      float64 `json:"crit"`
	ForSec    int     `json:"for_sec"` // 连续满足多少秒才真正告警，抑制抖动
	Direction string  `json:"direction,omitempty"`
	Enabled   *bool   `json:"enabled,omitempty"`
	Note      string  `json:"note,omitempty"`
}

type PortWatch struct {
	Name string `json:"name"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

type Collect struct {
	Disks     []string    `json:"disks,omitempty"`
	Processes []string    `json:"processes,omitempty"`
	Ports     []PortWatch `json:"ports,omitempty"`
	Network   *bool       `json:"network,omitempty"`
}

type Server struct {
	BaseURL           string `json:"base_url"`
	Token             string `json:"token"`
	AllowInsecureHTTP bool   `json:"allow_insecure_http,omitempty"`
	TimeoutMs         int    `json:"timeout_ms,omitempty"`
}

type ReportCfg struct {
	Enabled bool `json:"enabled"`
	EveryN  int  `json:"every_n,omitempty"` // 每 N 个采集周期上报一次，降低服务端写入
}

type Webhook struct {
	URL       string `json:"url"`
	Template  string `json:"template,omitempty"` // generic / wecom / dingtalk / feishu
	TimeoutMs int    `json:"timeout_ms,omitempty"`
}

type DesktopAlert struct {
	Enabled bool `json:"enabled"`
	// 只在交互式会话里弹；作为系统服务运行时通常没有桌面，会自动跳过
	OnlyOnCrit bool `json:"only_on_crit,omitempty"`
}

// WalletCfg 是桌面端「直接确认到账」的配置。
//
// 与手机端的分工：手机监听通知栏，桌面轮询账单。两者产出的事件
// 走同一个 /appPush，所以服务端不需要区分来源。
type WalletCfg struct {
	Enabled bool   `json:"enabled"`
	PID     string `json:"pid,omitempty"`      // 通道 ID，对应后台某条支付宝通道
	PollSec int    `json:"poll_sec,omitempty"` // 轮询间隔，默认 20 秒
	// 支付宝账单源。不配则不启用该源。
	Alipay *wallet.AlipayBillCfg `json:"alipay,omitempty"`
	// 微信通知源（当前仅 macOS 实现）。
	WeChat *wallet.WeChatCfg `json:"wechat,omitempty"`
}

type Alerts struct {
	CooldownSec int           `json:"cooldown_sec,omitempty"` // 同一规则同一级别的最小重发间隔
	Webhook     *Webhook      `json:"webhook,omitempty"`
	Desktop     *DesktopAlert `json:"desktop,omitempty"`
	LogFile     string        `json:"log_file,omitempty"`
}

type Config struct {
	AgentID     string    `json:"agent_id"`
	IntervalSec int       `json:"interval_sec"`
	Server      Server    `json:"server"`
	Report      ReportCfg `json:"report"`
	Collect     Collect   `json:"collect"`
	Rules       []Rule    `json:"rules"`
	Alerts      Alerts    `json:"alerts"`
	Wallet      WalletCfg `json:"wallet"`
	LogLevel    string    `json:"log_level,omitempty"`
	// 数据目录：放偏移量/状态等本地文件，默认与配置文件同目录
	DataDir string `json:"data_dir,omitempty"`

	// 运行期字段，不参与序列化
	Path string `json:"-"`
}

// DefaultPath 返回当前平台的默认配置路径。
func DefaultPath() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "vmq-agent", "config.json")
	case "darwin":
		return "/usr/local/etc/vmq-agent/config.json"
	default:
		return "/etc/vmq-agent/config.json"
	}
}

// DefaultDataDir 跟随配置路径，避免又多一个约定。
func DefaultDataDir(cfgPath string) string {
	if cfgPath == "" {
		cfgPath = DefaultPath()
	}
	return filepath.Dir(cfgPath)
}

// DefaultRules 是三个平台完全相同的一套初始阈值。
//
// 取舍：CPU/内存/磁盘用「持续 N 秒」而不是瞬时值，避免采集抖动和备份任务误报；
// 与支付业务直接相关的几条（监控端离线、回调失败、通道为空）宁可早报也不要漏报。
//
// 关于 0.5 这种「非整数阈值」：service_up / db_ready 是 1/0 的布尔指标，
// passages 是「0 个可用通道就算故障」的计数。用 0.5 表示「低于 1」，
// 是为了让「正常值 1」不被 <= 判定误伤 —— 直接写 warn=1 会把正常状态也判成警告。
func DefaultRules() []Rule {
	return []Rule{
		{Metric: "cpu_pct", Warn: 85, Crit: 95, ForSec: 120, Note: "持续高负载"},
		{Metric: "mem_pct", Warn: 90, Crit: 97, ForSec: 180, Note: "可用内存不足"},
		{Metric: "disk_pct", Warn: 85, Crit: 95, ForSec: 300, Note: "磁盘将满，Blob/日志写入会失败"},
		{Metric: "service_up", Warn: 0.5, Crit: 0, ForSec: 90, Direction: "below", Note: "支付服务不可达"},
		{Metric: "db_ready", Warn: 0.5, Crit: 0, ForSec: 120, Direction: "below", Note: "服务端存储未就绪"},
		{Metric: "monitor_offline_sec", Warn: 120, Crit: 600, ForSec: 0, Note: "收款监控端离线，到账不会自动确认"},
		{Metric: "notify_failed", Warn: 1, Crit: 5, ForSec: 60, Note: "商户回调失败堆积"},
		{Metric: "pending_orders", Warn: 20, Crit: 50, ForSec: 300, Note: "待支付订单堆积"},
		{Metric: "health_latency_ms", Warn: 1500, Crit: 3000, ForSec: 60, Note: "服务端响应变慢"},
		{Metric: "passages", Warn: 0.5, Crit: 0, ForSec: 300, Direction: "below", Note: "没有可用收款通道"},
		{Metric: "proc_missing", Warn: 1, Crit: 9999, ForSec: 180, Note: "点名的进程没在跑"},
		{Metric: "port_down", Warn: 1, Crit: 9999, ForSec: 120, Note: "点名的端口连不上"},
	}
}

// Default 构造一份可直接运行的默认配置（不含密钥）。
func Default() *Config {
	disks := []string{"/"}
	if runtime.GOOS == "windows" {
		d := os.Getenv("SystemDrive")
		if d == "" {
			d = "C:"
		}
		disks = []string{d + `\`}
	}
	net := true
	return &Config{
		IntervalSec: 30,
		Server:      Server{TimeoutMs: 5000},
		Report:      ReportCfg{Enabled: true, EveryN: 1},
		Collect:     Collect{Disks: disks, Processes: nil, Network: &net},
		Rules:       DefaultRules(),
		Alerts:      Alerts{CooldownSec: 600, Desktop: &DesktopAlert{Enabled: true}},
		LogLevel:    "info",
	}
}

// Load 读配置。文件不存在时返回默认配置（并允许纯 env 覆盖，便于容器化部署）。
func Load(path string) (*Config, error) {
	if path == "" {
		path = DefaultPath()
	}
	cfg := Default()
	cfg.Path = path

	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		// 先填默认值再覆盖，这样老配置缺字段也能跑
		if err := json.Unmarshal(raw, cfg); err != nil {
			return nil, fmt.Errorf("解析配置失败 %s: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
		// 允许完全靠环境变量跑起来
	default:
		return nil, fmt.Errorf("读取配置失败 %s: %w", path, err)
	}

	applyEnv(cfg)
	cfg.normalize()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// applyEnv 只覆盖敏感项与地址，方便用 systemd Environment= 或 Windows 服务环境变量注入密钥。
func applyEnv(c *Config) {
	if v := os.Getenv("VMQ_AGENT_SERVER"); v != "" {
		c.Server.BaseURL = v
	}
	if v := os.Getenv("VMQ_AGENT_TOKEN"); v != "" {
		c.Server.Token = v
	}
	if v := os.Getenv("VMQ_AGENT_ID"); v != "" {
		c.AgentID = v
	}
	if v := os.Getenv("VMQ_AGENT_INTERVAL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.IntervalSec = n
		}
	}
	if v := os.Getenv("VMQ_AGENT_LOG_LEVEL"); v != "" {
		c.LogLevel = v
	}
	if v := os.Getenv("VMQ_AGENT_WEBHOOK"); v != "" {
		if c.Alerts.Webhook == nil {
			c.Alerts.Webhook = &Webhook{}
		}
		c.Alerts.Webhook.URL = v
	}
}

func (c *Config) normalize() {
	c.Server.BaseURL = strings.TrimRight(strings.TrimSpace(c.Server.BaseURL), "/")
	if c.IntervalSec <= 0 {
		c.IntervalSec = 30
	}
	if c.Server.TimeoutMs <= 0 {
		c.Server.TimeoutMs = 5000
	}
	if c.Report.EveryN <= 0 {
		c.Report.EveryN = 1
	}
	if c.Alerts.CooldownSec <= 0 {
		c.Alerts.CooldownSec = 600
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	if c.Wallet.PollSec <= 0 {
		c.Wallet.PollSec = 20
	}
	if c.Wallet.Alipay != nil && c.Wallet.Alipay.Cookie == "" {
		// 登录态是敏感信息，优先从环境变量注入
		c.Wallet.Alipay.Cookie = os.Getenv("VMQ_ALIPAY_COOKIE")
	}
	if c.DataDir == "" {
		c.DataDir = DefaultDataDir(c.Path)
	}
	if c.AgentID == "" {
		// 主机名 + OS 足以在一堆机器里认出来；用户仍可在配置里覆盖
		h, _ := os.Hostname()
		h = strings.TrimSpace(h)
		if h == "" {
			h = "agent"
		}
		c.AgentID = fmt.Sprintf("%s-%s", strings.ToLower(h), runtime.GOOS)
	}
	for i := range c.Rules {
		if c.Rules[i].Direction == "" {
			c.Rules[i].Direction = "above"
		}
	}
}

// Validate 只做「跑不起来」级别的校验；阈值写错了由运行时告警暴露。
func (c *Config) Validate() error {
	if c.Server.BaseURL == "" {
		return errors.New("server.base_url 未配置（也可用环境变量 VMQ_AGENT_SERVER）")
	}
	if !strings.HasPrefix(c.Server.BaseURL, "https://") && !c.Server.AllowInsecureHTTP {
		if !isLoopback(c.Server.BaseURL) {
			return fmt.Errorf("server.base_url 必须是 https://%s；如确有需要，设 server.allow_insecure_http=true",
				strings.TrimPrefix(c.Server.BaseURL, "http://"))
		}
	}
	if c.IntervalSec < 5 {
		return fmt.Errorf("interval_sec 最小 5 秒，当前 %d", c.IntervalSec)
	}
	seen := map[string]bool{}
	for _, r := range c.Rules {
		if r.Metric == "" {
			return errors.New("存在缺少 metric 的规则")
		}
		if seen[r.Metric] {
			return fmt.Errorf("规则指标重复: %s", r.Metric)
		}
		seen[r.Metric] = true
		// 空串等价于 above（normalize 会补上），这里只拦真正写错的
		if r.Direction != "" && r.Direction != "above" && r.Direction != "below" {
			return fmt.Errorf("规则 %s 的 direction 只能是 above/below", r.Metric)
		}
	}
	if c.Wallet.Enabled {
		if c.Wallet.PID == "" {
			return errors.New("wallet.enabled=true 时必须配 wallet.pid（通道 ID），否则无法上报")
		}
		if (c.Wallet.Alipay == nil || c.Wallet.Alipay.Endpoint == "") && c.Wallet.WeChat == nil {
			return errors.New("wallet.enabled=true 但未配置任何到账来源（wallet.alipay / wallet.wechat）")
		}
	}
	if w := c.Alerts.Webhook; w != nil && w.URL != "" {
		if !strings.HasPrefix(w.URL, "http://") && !strings.HasPrefix(w.URL, "https://") {
			return errors.New("alerts.webhook.url 必须以 http(s):// 开头")
		}
	}
	return nil
}

func isLoopback(u string) bool {
	return strings.Contains(u, "127.0.0.1") || strings.Contains(u, "localhost") ||
		strings.Contains(u, "[::1]") || strings.HasPrefix(u, "http://10.") ||
		strings.HasPrefix(u, "http://192.168.")
}

// Timeout 三个 HTTP 客户端共用的超时。
func (c *Config) Timeout() time.Duration {
	return time.Duration(c.Server.TimeoutMs) * time.Millisecond
}

// Example 生成带注释说明的示例配置（-init 用）。
func Example() string {
	c := Default()
	c.Server.BaseURL = "https://pay.example.com"
	c.Server.Token = "<通讯密钥，或用 VMQ_AGENT_TOKEN 注入>"
	c.Collect.Processes = exampleProcesses()
	c.Collect.Ports = []PortWatch{{Name: "payment-api", Host: "127.0.0.1", Port: 443}}
	c.Alerts.Webhook = &Webhook{URL: "", Template: "generic", TimeoutMs: 5000}
	c.AgentID = ""
	b, _ := json.MarshalIndent(c, "", "  ")
	return string(b) + "\n"
}

func exampleProcesses() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{"WeChat.exe", "Alipay.exe"}
	case "darwin":
		return []string{"WeChat", "Alipay"}
	default:
		return []string{"node", "nginx"}
	}
}
