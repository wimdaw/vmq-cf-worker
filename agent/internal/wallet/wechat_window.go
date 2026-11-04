package wallet

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// WeChatWindow 通过「读微信窗口里的文本」来发现到账消息。
//
// 这是 PC 微信监控的正解：到账通知是**微信内部的收款助手/商业版服务号会话**，
// 不一定会写进系统通知中心，所以读窗口（而不是读通知）才是主路径。
// 业界成熟实现（wxauto，7k+ star）用的就是 Windows UIAutomation 遍历控件树，
// 不注入、不 hook、不逆向，行为上等同真人操作。
//
// 三端的能力对应：
//
//	Windows  UIAutomation（.NET UIAutomationClient，PowerShell 直接调）
//	macOS    Accessibility API（osascript + System Events，需「辅助功能」权限）
//	Linux    AT-SPI over D-Bus（当前未实现，见下）
//
// 约束（与 wxauto 一致，不是实现缺陷）：需要**微信客户端已登录且目标会话可见**。
// 请在微信里打开「微信收款助手」或「微信收款商业版」的会话并保持（可置顶），
// 程序读的就是当前聊天窗口里的文本。
type WeChatWindow struct {
	cfg       WeChatCfg
	timeout   time.Duration
	dedup     *Deduper
	procName  string
	scriptTmp string
	// primed 表示已经建立基线。首轮只登记已有消息、不产生事件 ——
	// 否则一启动就会把会话里的历史到账全部重推一遍，服务端全是「无匹配订单」。
	primed bool
}

func newWeChatWindow(cfg WeChatCfg, timeout time.Duration) (Source, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	w := &WeChatWindow{
		cfg:     cfg,
		timeout: timeout,
		dedup:   NewDeduper(2 * time.Hour),
	}

	switch runtime.GOOS {
	case "windows":
		w.procName = "WeChat"
	case "darwin":
		w.procName = "WeChat"
	default:
		return nil, fmt.Errorf("微信窗口读取当前支持 Windows / macOS；Linux 版微信功能残缺且无支付宝客户端，建议改用支付宝账单源")
	}

	// 一次性的能力自检：缺少 GUI 自动化依赖时提前报错，而不是每轮静默失败
	if err := w.selfCheck(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *WeChatWindow) Name() string { return "wechat-window" }

func (w *WeChatWindow) Platform() int { return TypeWeChat }

func (w *WeChatWindow) PID() string { return w.cfg.PID }

func (w *WeChatWindow) selfCheck() error {
	switch runtime.GOOS {
	case "windows":
		if _, err := exec.LookPath("powershell"); err != nil {
			return fmt.Errorf("未找到 powershell，无法使用 UIAutomation 读取微信窗口")
		}
	case "darwin":
		if _, err := exec.LookPath("osascript"); err != nil {
			return fmt.Errorf("未找到 osascript")
		}
	}
	return nil
}

// Poll 抓一次窗口文本，从里面找出「带金额的到账行」。
func (w *WeChatWindow) Poll(ctx context.Context) ([]Event, error) {
	text, err := w.readWindow(ctx)
	if err != nil {
		return nil, err
	}
	events := w.extract(text)
	if !w.primed {
		// 读到窗口内容即认为基线建立（即使当时一条匹配都没有）
		w.primed = true
	}
	return events, nil
}

// extract 从窗口文本里挑出到账消息。
//
// 判据：该行命中关键词 + 能提取到合法金额。
// 微信收款助手的历史消息会一并读到，所以必须去重 —— key 用「整行文本」，
// 同一行反复出现只算一次。
func (w *WeChatWindow) extract(text string) []Event {
	keywords := w.cfg.KeywordList()
	var out []Event
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || len(line) > 300 {
			continue
		}
		hit := false
		for _, k := range keywords {
			if strings.Contains(line, k) {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		money := ExtractMoney(line)
		if money == "" {
			continue
		}
		key := "line|" + line
		first := w.dedup.SeenBefore(key)
		if first {
			continue
		}
		if !w.primed {
			// 首轮：匹配到的行只登记为「已见」，不作为新到账。
			continue
		}
		out = append(out, Event{
			Platform: "wechat",
			Type:     TypeWeChat,
			Money:    money,
			Raw:      line,
			Source:   w.Name(),
			TS:       time.Now().Unix(),
		})
	}
	return out
}

// readWindow 调平台命令取当前微信聊天窗口的文本。
func (w *WeChatWindow) readWindow(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, w.timeout)
	defer cancel()

	var shell string
	var args []string

	switch runtime.GOOS {
	case "windows":
		// UIAutomation 脚本较长，写到临时 .ps1 再执行，避免命令行转义地狱
		path, err := w.ensureScript()
		if err != nil {
			return "", err
		}
		shell, args = "powershell", []string{
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path,
		}
	case "darwin":
		shell = "osascript"
		args = []string{"-e", darwinWindowScript(w.procName)}
	default:
		return "", fmt.Errorf("不支持的平台: %s", runtime.GOOS)
	}
	cmd := exec.CommandContext(ctx, shell, args...)
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			msg := strings.TrimSpace(string(ee.Stderr))
			if isPermissionError(msg) {
				return "", fmt.Errorf("%s\n提示：%s", msg, permissionHint())
			}
			return "", fmt.Errorf("%s: %s", shell, msg)
		}
		return "", fmt.Errorf("%s 执行失败: %w", shell, err)
	}
	return string(out), nil
}

// Debug 供 -wallet-probe 使用：原样返回读到的窗口文本，便于人工确认。
func (w *WeChatWindow) Debug(ctx context.Context) (string, error) {
	return w.readWindow(ctx)
}

// ensureScript 把 UIAutomation 脚本落到临时文件（只在 Windows 用）。
func (w *WeChatWindow) ensureScript() (string, error) {
	if w.scriptTmp != "" {
		if _, err := os.Stat(w.scriptTmp); err == nil {
			return w.scriptTmp, nil
		}
	}
	dir := filepath.Join(os.TempDir(), "vmq-agent")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "read-wechat-window.ps1")
	if err := os.WriteFile(p, []byte(windowsWindowScript(w.procName)), 0o644); err != nil {
		return "", err
	}
	w.scriptTmp = p
	return p, nil
}

// darwinWindowScript 用 System Events 把微信窗口里的静态文本拼出来。
//
// 需要「系统设置 → 隐私与安全性 → 辅助功能」授权给运行本程序的终端 / 服务。
// AX 树遍历本身不便宜，所以只在轮询周期里跑一次（默认 15~20 秒）。
func darwinWindowScript(proc string) string {
	return fmt.Sprintf(`
tell application "System Events"
  if not (exists process "%[1]s") then return ""
  tell process "%[1]s"
    set out to ""
    try
      repeat with w in windows
        try
          repeat with e in (entire contents of w)
            try
              set v to value of e
              if v is not missing value then set out to out & (v as text) & linefeed
            end try
            try
              set n to name of e
              if n is not missing value and n is not "" then set out to out & (n as text) & linefeed
            end try
          end repeat
        end try
      end repeat
    end try
    return out
  end tell
end tell`, proc)
}

// windowsWindowScript 用 UIAutomation 遍历微信窗口的所有 Text / ListItem 控件。
//
// 这是 wxauto 同款思路的最小化版本：不依赖控件层级（微信版本一换层级就变），
// 而是把窗口内所有文本节点平铺出来，交给 Go 侧做关键词匹配 ——
// 层级变了也不影响，最多多读/少读几行。
func windowsWindowScript(proc string) string {
	return fmt.Sprintf(`# 由 vmq-agent 生成：读取微信窗口内的全部文本，供到账关键词匹配
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$ErrorActionPreference = 'Stop'
$root = [System.Windows.Automation.AutomationElement]::RootElement
if ($null -eq $root) { exit 0 }

# 微信主窗口的类名在不同版本间比较稳定，优先用它定位；找不到再退回按进程名找
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'WeChatMainWndForPC')
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if ($null -eq $win) {
    $pc = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        (Get-Process -Name '%[1]s' -ErrorAction SilentlyContinue | Select-Object -First 1).Id)
    if ($pc) {
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pc)
    }
}
if ($null -eq $win) { exit 0 }

# 平铺所有文本节点：微信消息气泡、会话名、金额都是 Text 控件
$textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
$items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
foreach ($e in $items) {
    $v = $e.Current.Name
    if ($v) { [Console]::Out.WriteLine($v) }
}
`, proc)
}

// isPermissionError 识别「GUI 自动化权限缺失」，这是本功能最常见的失败原因，
// 报错必须直接告诉用户去哪里授权，否则只会看到一句无从下手的 permission violation。
func isPermissionError(msg string) bool {
	for _, k := range []string{"-10004", "权限违例", "not allowed assistive access", "Accessibility", "permission"} {
		if strings.Contains(msg, k) {
			return true
		}
	}
	return false
}

func permissionHint() string {
	switch runtime.GOOS {
	case "darwin":
		return "需要在「系统设置 → 隐私与安全性 → 辅助功能」里勾选运行本程序的终端或 LaunchDaemon，改完需重启该进程"
	case "windows":
		return "UIAutomation 被拒绝：请确认微信以当前用户身份运行，且本程序与微信在同一会话（不要以 SYSTEM 服务方式运行）"
	}
	return "缺少 GUI 自动化权限"
}
