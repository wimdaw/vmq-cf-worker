// Package rules 是跨平台共用的告警判定。
//
// 设计上有两个刻意的约束：
//
//  1. **持续时长门限（ForSec）**：瞬时越线不告警，必须连续满足 N 秒。
//     没有这一层的监控系统最后一定会被人关掉 —— 备份、编译、大文件拷贝
//     都会让 CPU/磁盘瞬时冲高，而这些都不是故障。
//
//  2. **状态机 + 恢复通知**：告警只在「级别变化」或「冷却期已过」时发出，
//     恢复时补一条 recovered。只报不恢复的告警，值班的人无法判断是否还在故障。
package rules

import (
	"fmt"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// state 是单条规则的运行期状态。进程重启后丢失，这是有意的取舍：
// 重启后重新计时比持久化状态更不容易出现「永远 pending」的僵尸状态。
type state struct {
	level        string    // 当前生效级别：""/warn/crit
	pendingSince time.Time // 首次越线时刻
	alerted      bool      // 是否已经对外发过告警
	lastSent     time.Time
	lastLevel    string
}

type Engine struct {
	rules    []config.Rule
	cooldown time.Duration
	states   map[string]*state
}

func New(rules []config.Rule, cooldown time.Duration) *Engine {
	if cooldown <= 0 {
		cooldown = 10 * time.Minute
	}
	return &Engine{
		rules:    rules,
		cooldown: cooldown,
		states:   map[string]*state{},
	}
}

// Evaluate 用一份指标表推进状态机，返回本次需要发出的告警（含恢复）。
func (e *Engine) Evaluate(metrics protocol.Metrics, now time.Time) []protocol.Alert {
	var out []protocol.Alert

	for _, r := range e.rules {
		if r.Enabled != nil && !*r.Enabled {
			continue
		}
		value, ok := metrics[r.Metric]
		if !ok {
			// 该平台没有这个指标（例如 Windows 没有 load average）：
			// 跳过而不是当成 0，否则会立刻误报。
			continue
		}
		level, threshold := judge(r, value)
		st := e.states[r.Metric]
		if st == nil {
			st = &state{}
			e.states[r.Metric] = st
		}

		if level == "" {
			// 回到正常：只有之前真的告过警才补恢复通知
			if st.alerted {
				out = append(out, protocol.Alert{
					Rule:      ruleID(r),
					Metric:    r.Metric,
					Level:     "ok",
					Value:     value,
					Threshold: threshold,
					Message:   fmt.Sprintf("已恢复：%s 回到 %s", labelOf(r), formatValue(r.Metric, value)),
					TS:        now.Unix(),
					Recovered: true,
				})
			}
			st.level, st.pendingSince, st.alerted, st.lastLevel = "", time.Time{}, false, ""
			continue
		}

		if st.pendingSince.IsZero() || st.level != level {
			st.pendingSince = now
		}
		st.level = level

		// 持续时长门限未满 —— 只记状态，不发告警
		if r.ForSec > 0 && now.Sub(st.pendingSince) < time.Duration(r.ForSec)*time.Second {
			continue
		}

		// 同级别在冷却期内不重复发；级别升级（warn→crit）立即发
		sameLevel := st.lastLevel == level
		if sameLevel && !st.lastSent.IsZero() && now.Sub(st.lastSent) < e.cooldown {
			continue
		}

		out = append(out, protocol.Alert{
			Rule:      ruleID(r),
			Metric:    r.Metric,
			Level:     level,
			Value:     value,
			Threshold: threshold,
			Message: fmt.Sprintf("%s：当前 %s，%s阈值 %s",
				labelOf(r), formatValue(r.Metric, value), levelZh(level), formatValue(r.Metric, threshold)),
			TS: now.Unix(),
		})
		st.alerted = true
		st.lastSent = now
		st.lastLevel = level
	}
	return out
}

// judge 返回当前级别与「触发该级别的那个阈值」。
//
// 这里有个容易踩的坑：Rule.Crit 是 float64，配置里不写就是 0。
// 如果直接拿 0 去比较，「所有 above 规则都会永远命中 crit」——
// 所以只有当 crit 确实比 warn 更严格时才启用 crit 这一档，
// 否则退化成只有 warn 的单档规则。
func judge(r config.Rule, v float64) (level string, threshold float64) {
	if r.Direction == "below" {
		// 越小越糟：crit 必须比 warn 更小才是有意义的「更严重」
		if r.Crit < r.Warn && v <= r.Crit {
			return protocol.LevelCrit, r.Crit
		}
		if v <= r.Warn {
			return protocol.LevelWarn, r.Warn
		}
		return "", 0
	}
	if r.Crit > r.Warn && v >= r.Crit {
		return protocol.LevelCrit, r.Crit
	}
	if v >= r.Warn {
		return protocol.LevelWarn, r.Warn
	}
	return "", 0
}

func ruleID(r config.Rule) string {
	if r.Note != "" {
		return r.Metric
	}
	return r.Metric
}

func labelOf(r config.Rule) string {
	if r.Note != "" {
		return r.Note
	}
	return r.Metric
}

func levelZh(l string) string {
	switch l {
	case protocol.LevelCrit:
		return "严重"
	case protocol.LevelWarn:
		return "警告"
	}
	return ""
}

// formatValue 按指标语义补单位。数字本身没法读，值班的人看到 "0.92" 不知道是秒还是比例。
func formatValue(metric string, v float64) string {
	switch metric {
	case protocol.MetricCPUPct, protocol.MetricMemPct, protocol.MetricDiskPct, protocol.MetricSwapPct:
		return fmt.Sprintf("%.1f%%", v)
	case protocol.MetricHealthMs:
		return fmt.Sprintf("%.0fms", v)
	case protocol.MetricMonitorOfflineSec:
		if v < 0 {
			return "未知（尚未绑定监控端）"
		}
		if v >= 3600 {
			return fmt.Sprintf("%.1f 小时", v/3600)
		}
		if v >= 60 {
			return fmt.Sprintf("%.0f 分钟", v/60)
		}
		return fmt.Sprintf("%.0f 秒", v)
	case protocol.MetricServiceUp, protocol.MetricDBReady:
		if v >= 1 {
			return "正常"
		}
		return "不可用"
	case protocol.MetricLoad1:
		return fmt.Sprintf("%.2f", v)
	default:
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d", int64(v))
		}
		return fmt.Sprintf("%.2f", v)
	}
}
