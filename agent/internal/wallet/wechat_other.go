//go:build !darwin

package wallet

import (
	"fmt"
	"time"
)

// 微信通知源在非 macOS 平台尚未实现，这里明确报错而不是静默返回空。
//
// 各平台的现状与原因（不是"没做完"，是路径确实不同）：
//
//	Linux   —— 可以做：桌面通知统一走 D-Bus org.freedesktop.Notifications，
//	           用 `dbus-monitor "member=Notify"` 订阅即可，无需任何依赖。
//	           尚未落地是因为解析 dbus-monitor 的文本输出需要针对
//	           GNOME/KDE 两种变体分别验证，不能凭空写。
//	Windows —— 难：通知落在 wpndatabase.db（SQLite + XML payload），
//	           但 Windows 不自带 sqlite3.exe，纯 Go 无 CGO 也读不了 SQLite；
//	           退而用 UI Automation 抓 Toast 窗口，对系统版本与主题敏感。
//
// 折中方案：这两端先用**支付宝账单轮询**覆盖到账确认（三平台同一份代码），
// 微信侧依赖手机端 monitor-android（Android 的通知监听本来就是全平台最强的）。
func newWeChat(cfg WeChatCfg, timeout time.Duration) (Source, error) {
	return nil, fmt.Errorf("微信通知源当前仅 macOS 支持；Linux/Windows 请用支付宝账单源，或继续使用 Android 监控端")
}
