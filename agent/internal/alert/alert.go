// Package alert 负责把判定出的告警送出去。
//
// 三平台共用同一个调度器，差异只落在 desktopNotify 一个函数上：
// Windows 用 PowerShell 气泡、macOS 用 osascript、Linux 用 notify-send。
// 其余通道（webhook / 日志 / 上报服务端）完全一致。
package alert

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/logging"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

type Dispatcher struct {
	webhook *config.Webhook
	desktop *config.DesktopAlert
	log     *logging.Logger
	client  *http.Client
}

func New(ac config.Alerts, log *logging.Logger) *Dispatcher {
	timeout := 5 * time.Second
	if ac.Webhook != nil && ac.Webhook.TimeoutMs > 0 {
		timeout = time.Duration(ac.Webhook.TimeoutMs) * time.Millisecond
	}
	return &Dispatcher{
		webhook: ac.Webhook,
		desktop: ac.Desktop,
		log:     log,
		client:  &http.Client{Timeout: timeout},
	}
}

// Dispatch 发送一批告警。任何一个通道失败都只记日志，不影响其它通道，
// 也不影响主循环 —— 告警发不出去时，采集必须继续。
func (d *Dispatcher) Dispatch(alerts []protocol.Alert, host protocol.Host) {
	for _, a := range alerts {
		tag := levelTag(a.Level)
		if a.Recovered {
			tag = "恢复"
		}
		d.log.Warnf("[告警][%s] %s", tag, a.Message)

		if d.webhook != nil && d.webhook.URL != "" {
			if err := d.sendWebhook(a, host); err != nil {
				d.log.Errorf("webhook 发送失败: %v", err)
			}
		}

		if d.desktop != nil && d.desktop.Enabled {
			if d.desktop.OnlyOnCrit && a.Level != protocol.LevelCrit && !a.Recovered {
				continue
			}
			if err := desktopNotify(desktopTitle(a), a.Message); err != nil {
				d.log.Debugf("桌面通知未发出（通常是无桌面会话）: %v", err)
			}
		}
	}
}

func levelTag(l string) string {
	switch l {
	case protocol.LevelCrit:
		return "严重"
	case protocol.LevelWarn:
		return "警告"
	case "ok":
		return "恢复"
	}
	return l
}

func desktopTitle(a protocol.Alert) string {
	if a.Recovered {
		return "V免签监控 · 已恢复"
	}
	return "V免签监控 · " + levelTag(a.Level)
}

// 供 main 打印自检信息
func (d *Dispatcher) Channels() []string {
	var out []string
	out = append(out, "log")
	if d.webhook != nil && d.webhook.URL != "" {
		tpl := d.webhook.Template
		if tpl == "" {
			tpl = "generic"
		}
		out = append(out, fmt.Sprintf("webhook(%s)", tpl))
	}
	if d.desktop != nil && d.desktop.Enabled {
		out = append(out, "desktop")
	}
	return out
}

func hostLabel(h protocol.Host) string {
	if h.Name == "" {
		return h.OS
	}
	return strings.TrimSpace(h.Name)
}
