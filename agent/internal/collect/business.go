package collect

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// statsResp 与 src/routes/home.ts 的 Stats 结构一一对应。
// 字段名保持 camelCase，和服务端 JSON 完全一致，对照排查时不用做心智转换。
type statsResp struct {
	DBReady bool   `json:"dbReady"`
	DBError string `json:"dbError"`
	TS      int64  `json:"ts"`
	Monitor struct {
		LastHeart int64 `json:"lastHeart"`
		LastPay   int64 `json:"lastPay"`
		Online    bool  `json:"online"`
	} `json:"monitor"`
	Passages    int            `json:"passages"`
	Orders      map[string]int `json:"orders"`
	TotalOrders int            `json:"totalOrders"`
}

var businessClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		MaxIdleConnsPerHost: 2,
	},
}

// collectBusiness 只读两个已有接口，不新增任何服务端隐私面：
//
//	/api/health —— 最轻的存活探测，用来算响应延迟
//	/api/stats  —— 看板页用的 JSON，含监控端心跳、各状态订单数、通道数
//
// 业务侧失败绝不阻断系统指标上报：网络断了的时候，「本机 CPU/磁盘」正是最需要
// 看到的现场。
func collectBusiness(cfg *config.Config, errs *[]string) protocol.Business {
	b := protocol.Business{BaseURL: cfg.Server.BaseURL, Orders: map[string]int{}}
	base := cfg.Server.BaseURL
	if base == "" {
		b.Error = "未配置 server.base_url"
		return b
	}

	// 1) 存活 + 延迟
	start := time.Now()
	resp, err := businessClient.Get(base + "/api/health")
	b.HealthMs = time.Since(start).Milliseconds()
	if err != nil {
		b.Up = false
		b.Error = err.Error()
		*errs = append(*errs, "health: "+err.Error())
		return b
	}
	b.HealthCode = resp.StatusCode
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	b.Up = resp.StatusCode == http.StatusOK
	if !b.Up {
		b.Error = fmt.Sprintf("健康检查返回 HTTP %d", resp.StatusCode)
	}

	// 2) 业务指标
	sresp, err := businessClient.Get(base + "/api/stats")
	if err != nil {
		*errs = append(*errs, "stats: "+err.Error())
		return b
	}
	defer sresp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(sresp.Body, 1<<20))
	if err != nil {
		*errs = append(*errs, "stats 读取失败: "+err.Error())
		return b
	}
	var s statsResp
	if err := json.Unmarshal(body, &s); err != nil {
		*errs = append(*errs, "stats 解析失败: "+err.Error())
		return b
	}

	b.DBReady = s.DBReady
	b.ServerTS = s.TS
	b.MonitorLastHeart = s.Monitor.LastHeart
	b.MonitorLastPay = s.Monitor.LastPay
	b.MonitorOnline = s.Monitor.Online
	b.Passages = s.Passages
	b.TotalOrders = s.TotalOrders
	if s.Orders != nil {
		b.Orders = s.Orders
	}
	if s.DBError != "" {
		*errs = append(*errs, "服务端存储: "+s.DBError)
	}

	// 监控端离线时长。用服务端时间戳算，避免客户端时钟漂移导致误报。
	//
	// lastHeart == 0 表示「还没绑定过监控端」，此时离线时长用 -1 表示未知：
	// 直接报一个大数会让全新部署在绑定之前一直告警，属于噪声而不是信号。
	switch {
	case s.Monitor.LastHeart <= 0:
		b.MonitorOfflineSec = -1
	case s.Monitor.Online:
		b.MonitorOfflineSec = 0
	default:
		if s.TS > s.Monitor.LastHeart {
			b.MonitorOfflineSec = s.TS - s.Monitor.LastHeart
		}
	}
	return b
}
