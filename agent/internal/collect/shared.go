package collect

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// probePort 用「真连一次 TCP」判断端口存活。
// 比读监听表更可靠：读表只能看到「有没有在听」，连一次能发现防火墙、
// 只监听回环、上游已经挂掉等问题。代价是每次几毫秒，可接受。
func probePort(p config.PortWatch) protocol.Port {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	addr := net.JoinHostPort(host, strconv.Itoa(p.Port))
	out := protocol.Port{Name: p.Name, Addr: addr}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	out.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		out.Reachable = false
		out.Error = err.Error()
		return out
	}
	out.Reachable = true
	_ = conn.Close()
	return out
}

// currentUser 三平台统一的取值方式：先看环境变量，再退到占位符。
// 作为服务运行时 USER 往往是空的，此时显示「(service)」比显示空更有信息量。
func currentUser() string {
	for _, k := range []string{"USER", "USERNAME", "LOGNAME"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return "(service)"
}

// runCmd 统一带超时地跑一条外部命令。监控程序调用系统命令必须设上限 ——
// 一条卡住的子进程足以让整个采集循环停摆，而这正是最需要它活着的时候。
func runCmd(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd) // Windows 下隐藏控制台窗口；Unix 是空实现
	out, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("%s 超时(%s)", name, timeout)
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("%s: %s", name, strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// parseFloat 容忍「1.23」与空串，解析失败返回 0。
func parseFloat(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return f
}

func parseUint(s string) uint64 {
	u, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return u
}

// procRow 是各平台进程列表的统一中间形态：只保留「基名 + pid」。
type procRow struct {
	Name string
	PID  int
}

// matchProcs 三平台共用的进程匹配逻辑。
//
// 用「忽略大小写的包含匹配」而不是精确相等：macOS 拿到的是完整路径，
// Windows 的进程名带 .exe，Linux 可能被截断到 15 字符 ——
// 包含匹配让同一份配置在三平台都能命中，代价是可能多匹配到同名前缀的进程，
// 对「进程在不在」这个判断没有影响。
func matchProcs(wanted []string, rows []procRow) []protocol.Proc {
	out := make([]protocol.Proc, 0, len(wanted))
	for _, w := range wanted {
		lw := strings.ToLower(strings.TrimSpace(w))
		if lw == "" {
			continue
		}
		p := protocol.Proc{Name: w}
		for _, r := range rows {
			if strings.Contains(strings.ToLower(r.Name), lw) {
				p.Count++
				if r.PID > 0 && len(p.PIDs) < 5 {
					p.PIDs = append(p.PIDs, r.PID)
				}
			}
		}
		p.Running = p.Count > 0
		out = append(out, p)
	}
	return out
}
