package collect

import (
	"testing"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// 进程匹配是三平台共用逻辑，且直接决定「进程没在跑」这条告警是否可信。
func TestMatchProcs(t *testing.T) {
	rows := []procRow{
		{Name: "WeChat", PID: 100},
		{Name: "WeChatHelper", PID: 101},
		{Name: "node", PID: 200},
		{Name: "nginx", PID: 300},
	}

	got := matchProcs([]string{"wechat", "nginx", "alipay"}, rows)
	if len(got) != 3 {
		t.Fatalf("应返回 3 条，实际 %d", len(got))
	}
	// 忽略大小写 + 包含匹配：wechat 同时命中 WeChat 与 WeChatHelper
	if !got[0].Running || got[0].Count != 2 {
		t.Errorf("wechat 应命中 2 个进程，实际 %+v", got[0])
	}
	if !got[1].Running {
		t.Errorf("nginx 应在跑")
	}
	if got[2].Running {
		t.Errorf("alipay 不该被判定为在跑")
	}
}

func TestMatchProcsEmptyName(t *testing.T) {
	// 空名字如果不跳过，包含匹配会命中所有进程，把「没在跑」变成「全在跑」
	got := matchProcs([]string{"  "}, []procRow{{Name: "node", PID: 1}})
	if len(got) != 0 {
		t.Fatalf("空名字应被跳过，实际 %+v", got)
	}
}

func TestFlatten(t *testing.T) {
	rep := protocol.Report{
		System: protocol.System{
			CPU: protocol.CPU{UsagePct: 12.5},
			Mem: protocol.Mem{UsedPct: 40, SwapUsedPct: 5},
			Disks: []protocol.Disk{
				{Mount: "/", UsedPct: 55},
				{Mount: "/data", UsedPct: 88},
			},
			Procs: []protocol.Proc{{Name: "a", Running: true}, {Name: "b", Running: false}},
			Ports: []protocol.Port{{Name: "p", Reachable: true}, {Name: "q", Reachable: false}},
		},
		Business: protocol.Business{
			Up: true, DBReady: true, HealthMs: 42, Passages: 2, TotalOrders: 7,
			MonitorOfflineSec: 0,
			Orders:            map[string]int{"0": 3, "1": 9, "2": 1, "3": 4},
		},
	}

	m := flatten(rep)

	// disk_pct 取「最满的那个挂载点」，不是平均值也不是根分区
	if m[protocol.MetricDiskPct] != 88 {
		t.Errorf("disk_pct 应取最满的 88，实际 %v", m[protocol.MetricDiskPct])
	}
	if m[protocol.MetricProcMissing] != 1 {
		t.Errorf("proc_missing 应为 1，实际 %v", m[protocol.MetricProcMissing])
	}
	if m[protocol.MetricPortDown] != 1 {
		t.Errorf("port_down 应为 1，实际 %v", m[protocol.MetricPortDown])
	}
	if m[protocol.MetricServiceUp] != 1 || m[protocol.MetricDBReady] != 1 {
		t.Errorf("布尔指标应映射成 1/0")
	}
	if m[protocol.MetricPendingOrders] != 3 || m[protocol.MetricPaidOrders] != 9 ||
		m[protocol.MetricNotifyFailed] != 1 || m[protocol.MetricExpiredOrders] != 4 {
		t.Errorf("订单状态映射错误: %+v", m)
	}
	// Windows 没有 load1：不能凭空出现这个键，否则规则会拿 0 去判定
	if _, ok := m[protocol.MetricLoad1]; ok {
		t.Errorf("没有 load average 时不该生成 load1 指标")
	}
}
