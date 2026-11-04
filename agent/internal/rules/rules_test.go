package rules

import (
	"testing"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

func at(sec int) time.Time {
	return time.Unix(1_700_000_000+int64(sec), 0)
}

func m(k string, v float64) protocol.Metrics { return protocol.Metrics{k: v} }

func TestForSecSuppressesFlapping(t *testing.T) {
	e := New([]config.Rule{{Metric: "cpu_pct", Warn: 80, ForSec: 60}}, time.Minute)

	// 第一秒越线：进入 pending，不告警
	if got := e.Evaluate(m("cpu_pct", 95), at(0)); len(got) != 0 {
		t.Fatalf("未满持续时长就告警了: %+v", got)
	}
	// 30 秒仍在越线：还是不告警
	if got := e.Evaluate(m("cpu_pct", 95), at(30)); len(got) != 0 {
		t.Fatalf("30s 时不该告警: %+v", got)
	}
	// 60 秒：达到门限，告警
	if got := e.Evaluate(m("cpu_pct", 95), at(61)); len(got) != 1 {
		t.Fatalf("达到 for_sec 应当告警，实际 %d 条", len(got))
	}
}

func TestCooldownDeduplicatesSameLevel(t *testing.T) {
	e := New([]config.Rule{{Metric: "cpu_pct", Warn: 80, ForSec: 0}}, time.Minute)

	if got := e.Evaluate(m("cpu_pct", 95), at(0)); len(got) != 1 {
		t.Fatalf("首次应告警")
	}
	// 冷却期内同级别不重复
	if got := e.Evaluate(m("cpu_pct", 96), at(30)); len(got) != 0 {
		t.Fatalf("冷却期内不该重复告警")
	}
	// 超过冷却期，重新提醒一次
	if got := e.Evaluate(m("cpu_pct", 97), at(61)); len(got) != 1 {
		t.Fatalf("冷却结束后应再次告警")
	}
}

func TestEscalationIsImmediate(t *testing.T) {
	e := New([]config.Rule{{Metric: "cpu_pct", Warn: 80, Crit: 95, ForSec: 0}}, time.Hour)

	if got := e.Evaluate(m("cpu_pct", 85), at(0)); len(got) != 1 || got[0].Level != protocol.LevelWarn {
		t.Fatalf("应先 warn: %+v", got)
	}
	// 升级立刻发，不受冷却期限制
	got := e.Evaluate(m("cpu_pct", 99), at(5))
	if len(got) != 1 || got[0].Level != protocol.LevelCrit {
		t.Fatalf("升级应立即发 crit: %+v", got)
	}
}

func TestRecoveryIsEmitted(t *testing.T) {
	e := New([]config.Rule{{Metric: "cpu_pct", Warn: 80, Crit: 95, ForSec: 0}}, time.Minute)

	e.Evaluate(m("cpu_pct", 95), at(0))
	got := e.Evaluate(m("cpu_pct", 10), at(10))
	if len(got) != 1 || !got[0].Recovered {
		t.Fatalf("回到正常应发恢复通知: %+v", got)
	}
	if got[0].Level != "ok" {
		t.Fatalf("恢复通知的 level 应为 ok，实际 %s", got[0].Level)
	}
	// 恢复后不应重复发
	if again := e.Evaluate(m("cpu_pct", 10), at(20)); len(again) != 0 {
		t.Fatalf("恢复通知只该发一次: %+v", again)
	}
}

func TestBelowDirection(t *testing.T) {
	// service_up: 1=正常 0=不可用。direction=below 时「越小越糟」，
	// 且 crit 的阈值比 warn 更小 —— 0 直接算严重。
	e := New([]config.Rule{
		{Metric: "service_up", Warn: 0.5, Crit: 0, ForSec: 0, Direction: "below"},
	}, time.Minute)

	got := e.Evaluate(m("service_up", 0), at(0))
	if len(got) != 1 || got[0].Level != protocol.LevelCrit {
		t.Fatalf("服务不可用应为 crit: %+v", got)
	}
	if rec := e.Evaluate(m("service_up", 1), at(5)); len(rec) != 1 || !rec[0].Recovered {
		t.Fatalf("服务恢复应发恢复通知: %+v", rec)
	}
}

func TestMissingMetricIsSkipped(t *testing.T) {
	// Windows 没有 load1；规则不能因为拿不到指标就当成 0 去判定
	e := New([]config.Rule{{Metric: "load1", Warn: 1, ForSec: 0}}, time.Minute)
	if got := e.Evaluate(protocol.Metrics{"cpu_pct": 1}, at(0)); len(got) != 0 {
		t.Fatalf("指标缺失时不该告警: %+v", got)
	}
}

func TestDisabledRule(t *testing.T) {
	off := false
	e := New([]config.Rule{{Metric: "cpu_pct", Warn: 1, ForSec: 0, Enabled: &off}}, time.Minute)
	if got := e.Evaluate(m("cpu_pct", 99), at(0)); len(got) != 0 {
		t.Fatalf("已禁用的规则不该告警")
	}
}

func TestFormatValueUnits(t *testing.T) {
	cases := []struct {
		metric string
		v      float64
		want   string
	}{
		{"monitor_offline_sec", 7200, "2.0 小时"},
		{"monitor_offline_sec", 120, "2 分钟"},
		{"monitor_offline_sec", 30, "30 秒"},
		{"monitor_offline_sec", -1, "未知（尚未绑定监控端）"},
		{"cpu_pct", 85.25, "85.2%"},
		{"health_latency_ms", 1500, "1500ms"},
		{"service_up", 1, "正常"},
		{"service_up", 0, "不可用"},
		{"pending_orders", 3, "3"},
	}
	for _, c := range cases {
		if got := formatValue(c.metric, c.v); got != c.want {
			t.Errorf("formatValue(%s, %v) = %q，期望 %q", c.metric, c.v, got, c.want)
		}
	}
}
