package collect

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// ---------------- CPU ----------------

// platformCPU 两次读 /proc/stat 求差，得到这段时间的真实使用率。
func platformCPU() (float64, error) {
	idle1, total1, err := cpuTimes()
	if err != nil {
		return 0, err
	}
	time.Sleep(250 * time.Millisecond)
	idle2, total2, err := cpuTimes()
	if err != nil {
		return 0, err
	}
	if total2 <= total1 {
		return 0, errNoData
	}
	dt := float64(total2 - total1)
	di := float64(idle2 - idle1)
	return (dt - di) / dt * 100, nil
}

// cpuTimes 读 /proc/stat 第一行：
// cpu  user nice system idle iowait irq softirq steal guest guest_nice
// idle 计入 idle+iowait，其余全部计入 total —— 与 top 的口径一致。
func cpuTimes() (idle, total uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0, 0, errNoData
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, errNoData
	}
	for i, raw := range fields[1:] {
		v := parseUint(raw)
		total += v
		if i == 3 || i == 4 { // idle / iowait
			idle += v
		}
	}
	if total == 0 {
		return 0, 0, errNoData
	}
	return idle, total, nil
}

var errNoData = &procError{"无可用数据"}

type procError struct{ msg string }

func (e *procError) Error() string { return e.msg }

func loadAvg() (l1, l5, l15 float64, ok bool) {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, false
	}
	f := strings.Fields(string(raw))
	if len(f) < 3 {
		return 0, 0, 0, false
	}
	return parseFloat(f[0]), parseFloat(f[1]), parseFloat(f[2]), true
}

func uptime() (time.Duration, error) {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	f := strings.Fields(string(raw))
	if len(f) == 0 {
		return 0, errNoData
	}
	secs := parseFloat(f[0])
	return time.Duration(secs * float64(time.Second)), nil
}

// ---------------- 内存 ----------------

// memUsageOf 用 MemAvailable 作为 available。
// 不用 MemFree：Linux 会把空闲内存大量用作 page cache，MemFree 长期偏小，
// 拿它算使用率会稳定虚高，是监控里最常见的误报来源之一。
func memUsageOf() (memUsage, error) {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return memUsage{}, err
	}
	kv := map[string]uint64{}
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, ':')
		if i <= 0 {
			continue
		}
		key := line[:i]
		rest := strings.Fields(line[i+1:])
		if len(rest) == 0 {
			continue
		}
		// 值都以 kB 为单位
		kv[key] = parseUint(rest[0]) * 1024
	}

	total := kv["MemTotal"]
	if total == 0 {
		return memUsage{}, errNoData
	}
	avail, ok := kv["MemAvailable"]
	if !ok {
		// 老内核（3.14 之前）没有 MemAvailable，退回 free+buffers+cached
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	if avail > total {
		avail = total
	}

	var swapTotal, swapUsed uint64
	if st := kv["SwapTotal"]; st > 0 {
		swapTotal = st
		free := kv["SwapFree"]
		if free <= st {
			swapUsed = st - free
		}
	}
	return memUsage{total: total, available: avail, swapTotal: swapTotal, swapUsed: swapUsed}, nil
}

// ---------------- 磁盘 ----------------

func diskUsage(mount string) (protocol.Disk, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(mount, &st); err != nil {
		return protocol.Disk{}, err
	}
	bs := uint64(st.Bsize)
	total := st.Blocks * bs
	// Bavail 是「非 root 可用」，比 Bfree 更贴近实际能写入的空间
	free := st.Bavail * bs
	out := protocol.Disk{Mount: mount, TotalBytes: total, FreeBytes: free}
	if total > 0 {
		out.UsedPct = round2(float64(total-free) / float64(total) * 100)
	}
	return out, nil
}

// ---------------- 网络 ----------------

// netBytes 读 /proc/net/dev，跳过回环。
func netBytes() (rx, tx uint64, err error) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, ':')
		if i <= 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		if name == "" || strings.HasPrefix(name, "lo") {
			continue
		}
		rest := strings.Fields(line[i+1:])
		// 接收：bytes packets errs drop fifo frame compressed multicast
		// 发送：bytes packets errs drop fifo colls carrier compressed
		if len(rest) < 9 {
			continue
		}
		rx += parseUint(rest[0])
		tx += parseUint(rest[8])
	}
	return rx, tx, nil
}

// ---------------- 进程 ----------------

func processList(names []string) ([]protocol.Proc, error) {
	out, err := runCmd(5*time.Second, "ps", "-Ao", "pid=,comm=")
	if err != nil {
		return nil, err
	}
	var rows []procRow
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 {
			continue
		}
		rows = append(rows, procRow{
			PID:  int(parseUint(parts[0])),
			Name: filepath.Base(strings.TrimSpace(parts[1])),
		})
	}
	return matchProcs(names, rows), nil
}

// ---------------- 系统信息 ----------------

func osVersion() string {
	name := "Linux"
	if raw, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				name = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
				break
			}
		}
	}
	if k, err := runCmd(3*time.Second, "uname", "-r"); err == nil && k != "" {
		name += " " + k
	}
	return name
}

func platformNotes() []string {
	var notes []string
	if _, err := exec.LookPath("notify-send"); err != nil {
		notes = append(notes, "未找到 notify-send，桌面弹窗告警不可用（webhook 不受影响）")
	}
	return notes
}
