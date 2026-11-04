package alert

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// desktopNotify 走 libnotify 的 notify-send。
//
// 依赖桌面环境提供的通知守护进程（GNOME/KDE/XFCE 都自带）。
// 纯命令行的服务器上通常没装，此时返回错误，采集不受影响。
func desktopNotify(title, body string) error {
	bin, err := exec.LookPath("notify-send")
	if err != nil {
		return fmt.Errorf("未找到 notify-send（Debian/Ubuntu: apt install libnotify-bin）")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 参数直接传，不拼 shell 字符串，正文里的引号/分号不会造成注入
	cmd := exec.CommandContext(ctx, bin, "-a", "V免签监控", "-u", "normal", title, body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("notify-send: %w %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
