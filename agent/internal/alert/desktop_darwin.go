package alert

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// desktopNotify 走 osascript 的 display notification。
//
// 只有在**图形登录会话**里才有效：作为 LaunchDaemon 跑时没有 WindowServer
// 会话，这里会直接报错，调用方按 debug 级别记一笔然后继续 —— 这是预期行为，
// 服务端部署请把 alerts.webhook 配上。
func desktopNotify(title, body string) error {
	script := fmt.Sprintf(
		`display notification "%s" with title "%s"`,
		escapeAppleScript(body), escapeAppleScript(title),
	)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "not allowed") {
			return fmt.Errorf("系统未允许发送通知（可在「系统设置 → 通知」里放行）")
		}
		return fmt.Errorf("osascript: %w %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// escapeAppleScript 处理 AppleScript 字符串字面量里的两个特殊字符。
// 不直接拼用户输入到脚本里，是因为告警正文里可能带引号（例如 JSON 片段）。
func escapeAppleScript(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}
