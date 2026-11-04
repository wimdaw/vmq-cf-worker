package alert

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

func timeOf(ts int64) time.Time { return time.Unix(ts, 0) }

// sendWebhook 按模板组装请求体。
//
// 三种 IM 机器人的文本消息结构虽然长得像，但字段名和嵌套不同，
// 用模板区分比让用户自己拼 JSON 现实得多：
//
//	wecom    {"msgtype":"text","text":{"content":"..."}}
//	dingtalk {"msgtype":"text","text":{"content":"..."}}   ← 与企微同形
//	feishu   {"msg_type":"text","content":{"text":"..."}}  ← 注意是 msg_type/content
//	generic  自定义消费方拿结构化字段，见下
func (d *Dispatcher) sendWebhook(a protocol.Alert, host protocol.Host) error {
	tpl := "generic"
	if d.webhook != nil && d.webhook.Template != "" {
		tpl = d.webhook.Template
	}

	text := fmt.Sprintf("[%s] %s\n主机：%s（%s）\n时间：%s",
		levelTagOf(a), a.Message, hostLabel(host), host.OS,
		timeOf(a.TS).Format("2006-01-02 15:04:05"))

	var payload any
	switch tpl {
	case "wecom", "dingtalk":
		payload = map[string]any{
			"msgtype": "text",
			"text":    map[string]string{"content": text},
		}
	case "feishu":
		payload = map[string]any{
			"msg_type": "text",
			"content":  map[string]string{"text": text},
		}
	default:
		payload = map[string]any{
			"source": "vmq-agent",
			"agent": map[string]any{
				"id":   a.Rule,
				"host": host.Name,
				"os":   host.OS,
				"arch": host.Arch,
			},
			"alert": a,
			"text":  text,
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, d.webhook.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(snippet))
	}
	return nil
}

func levelTagOf(a protocol.Alert) string {
	if a.Recovered {
		return "恢复"
	}
	return levelTag(a.Level)
}
