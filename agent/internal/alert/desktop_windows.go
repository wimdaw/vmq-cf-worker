package alert

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func hideWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}

// desktopNotify 用 PowerShell 弹一个系统气泡通知。
//
// 标题和正文通过**环境变量**传给子进程，而不是拼进脚本文本：
// 告警正文里可能带引号、中文和路径，拼字符串迟早会因为转义问题炸掉。
//
// 以服务身份（session 0）运行时没有桌面，NotifyIcon 无法创建，会返回错误；
// 调用方按 debug 记录后继续——这是预期行为，服务端部署请配置 webhook。
func desktopNotify(title, body string) error {
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.Visible = $true
$n.ShowBalloonTip(8000, $env:VMQ_ALERT_TITLE, $env:VMQ_ALERT_BODY, [System.Windows.Forms.ToolTipIcon]::Warning)
Start-Sleep -Seconds 8
$n.Dispose()
`
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(),
		"VMQ_ALERT_TITLE="+title,
		"VMQ_ALERT_BODY="+body,
	)
	cmd.SysProcAttr = hideWindowAttr()

	out, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "session") || strings.Contains(string(out), "interactive") {
			return fmt.Errorf("无交互式桌面会话，无法弹窗")
		}
		return fmt.Errorf("powershell 通知失败: %w %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
