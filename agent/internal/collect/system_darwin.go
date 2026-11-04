package collect

import (
	"bufio"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// ---------------- CPU ----------------

// platformCPU 先试 kern.cp_time（累计滴答求差，精度最好），
// 不可用时退回 iostat 的区间采样。
//
// 为什么需要兜底：kern.cp_time 在部分 macOS 版本 / Apple Silicon 上已经没有这个 oid
// （实测 macOS 13.7 arm64 返回 unknown oid）。只认这一条会直接丢掉 CPU 指标。
func platformCPU() (float64, error) {
	if idle1, total1, err := cpuTimes(); err == nil {
		time.Sleep(250 * time.Millisecond)
		if idle2, total2, err2 := cpuTimes(); err2 == nil && total2 > total1 {
			dt := float64(total2 - total1)
			di := float64(idle2 - idle1)
			return (dt - di) / dt * 100, nil
		}
	}
	return iostatCPU()
}

// cpuTimes 读 kern.cp_time：五个累计「时钟滴答」，顺序是 user nice sys idle intr。
func cpuTimes() (idle, total uint64, err error) {
	out, err := runCmd(3*time.Second, "sysctl", "-n", "kern.cp_time")
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(out)
	if len(fields) < 4 {
		return 0, 0, fmt.Errorf("kern.cp_time 格式异常: %q", out)
	}
	var v [4]uint64
	for i := 0; i < 4; i++ {
		v[i] = parseUint(fields[i])
	}
	idle = v[3]
	total = v[0] + v[1] + v[2] + v[3]
	if total == 0 {
		return 0, 0, fmt.Errorf("kern.cp_time 全为 0")
	}
	return idle, total, nil
}

// iostatCPU 取 iostat 最后一条采样行的 us+sy。
// -c 2 表示采两次，只有第二次才是「这个间隔内」的值，第一次是开机以来的均值。
func iostatCPU() (float64, error) {
	out, err := runCmd(8*time.Second, "iostat", "-c", "2", "-w", "1")
	if err != nil {
		return 0, fmt.Errorf("kern.cp_time 与 iostat 均不可用: %w", err)
	}
	var last []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		// 数据行至少有 6 列且前 6 列都是数字（表头里的 KB/t、us 解析不出来）
		if len(f) < 6 {
			continue
		}
		numOK := true
		for i := 0; i < 6; i++ {
			if _, err := strconv.ParseFloat(f[i], 64); err != nil {
				numOK = false
				break
			}
		}
		if numOK {
			last = f
		}
	}
	if last == nil {
		return 0, fmt.Errorf("iostat 输出无法解析")
	}
	us := parseFloat(last[3])
	sy := parseFloat(last[4])
	return us + sy, nil
}

func loadAvg() (l1, l5, l15 float64, ok bool) {
	out, err := runCmd(3*time.Second, "sysctl", "-n", "vm.loadavg")
	if err != nil {
		return 0, 0, 0, false
	}
	// 形如：{ 1.85 2.03 2.11 }
	out = strings.Trim(strings.TrimSpace(out), "{}")
	f := strings.Fields(out)
	if len(f) < 3 {
		return 0, 0, 0, false
	}
	return parseFloat(f[0]), parseFloat(f[1]), parseFloat(f[2]), true
}

func uptime() (time.Duration, error) {
	out, err := runCmd(3*time.Second, "sysctl", "-n", "kern.boottime")
	if err != nil {
		return 0, err
	}
	// 形如：{ sec = 1730000000, usec = 123456 } Wed Oct 30 ...
	re := regexp.MustCompile(`sec\s*=\s*(\d+)`)
	m := re.FindStringSubmatch(out)
	if len(m) != 2 {
		return 0, fmt.Errorf("kern.boottime 格式异常: %q", out)
	}
	boot := int64(parseUint(m[1]))
	if boot <= 0 {
		return 0, fmt.Errorf("kern.boottime 为 0")
	}
	return time.Duration(time.Now().Unix()-boot) * time.Second, nil
}

// ---------------- 内存 ----------------

// memUsageOf：hw.memsize 给总量，vm_stat 给分页计数。
//
// available 刻意取 free + inactive + speculative：
// macOS 会把大量内存拿去做文件缓存，只看 "Pages free" 常年接近 0，
// 直接用 free 算使用率会一直显示 97%，属于典型误报。
func memUsageOf() (memUsage, error) {
	out, err := runCmd(3*time.Second, "sysctl", "-n", "hw.memsize")
	if err != nil {
		return memUsage{}, err
	}
	total := parseUint(out)
	if total == 0 {
		return memUsage{}, fmt.Errorf("hw.memsize 为 0")
	}

	vm, err := runCmd(5*time.Second, "vm_stat")
	if err != nil {
		return memUsage{}, err
	}

	pageSize := uint64(4096)
	var free, inactive, speculative uint64
	sc := bufio.NewScanner(strings.NewReader(vm))
	for sc.Scan() {
		line := sc.Text()
		if strings.Contains(line, "page size of") {
			pageSize = parsePageSize(line, pageSize)
			continue
		}
		switch {
		case strings.HasPrefix(line, "Pages free:"):
			free = pageCount(line, "Pages free:")
		case strings.HasPrefix(line, "Pages inactive:"):
			inactive = pageCount(line, "Pages inactive:")
		case strings.HasPrefix(line, "Pages speculative:"):
			speculative = pageCount(line, "Pages speculative:")
		}
	}

	avail := (free + inactive + speculative) * pageSize
	if avail > total {
		avail = total
	}
	swTotal, swUsed := swapUsage()
	return memUsage{total: total, available: avail, swapTotal: swTotal, swapUsed: swUsed}, nil
}

func parsePageSize(line string, def uint64) uint64 {
	i := strings.Index(line, "page size of")
	seg := strings.TrimSpace(line[i+len("page size of"):])
	seg = strings.TrimSuffix(seg, ")")
	seg = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(seg), "bytes"))
	if n := parseUint(seg); n > 0 {
		return n
	}
	return def
}

func pageCount(line, prefix string) uint64 {
	rest := strings.TrimSpace(strings.TrimPrefix(line, prefix))
	rest = strings.TrimSuffix(rest, ".")
	return parseUint(rest)
}

var swapRe = regexp.MustCompile(`total\s*=\s*([\d.]+)([MG])`)

// swapUsage 解析 `sysctl vm.swapusage`：
// total = 2048.00M  used = 123.25M  free = 1924.75M  (encrypted)
func swapUsage() (total, used uint64) {
	out, err := runCmd(3*time.Second, "sysctl", "-n", "vm.swapusage")
	if err != nil {
		return 0, 0
	}
	num := `([\d.]+)([MG])`
	reT := regexp.MustCompile(`total\s*=\s*` + num)
	reU := regexp.MustCompile(`used\s*=\s*` + num)
	toBytes := func(m []string) uint64 {
		if len(m) != 3 {
			return 0
		}
		v := parseFloat(m[1])
		switch m[2] {
		case "G":
			return uint64(v * 1024 * 1024 * 1024)
		case "M":
			return uint64(v * 1024 * 1024)
		}
		return 0
	}
	return toBytes(reT.FindStringSubmatch(out)), toBytes(reU.FindStringSubmatch(out))
}

// ---------------- 磁盘 ----------------

func diskUsage(mount string) (protocol.Disk, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(mount, &st); err != nil {
		return protocol.Disk{}, err
	}
	bs := uint64(st.Bsize)
	total := st.Blocks * bs
	free := st.Bavail * bs
	out := protocol.Disk{Mount: mount, TotalBytes: total, FreeBytes: free}
	if total > 0 {
		out.UsedPct = round2(float64(total-free) / float64(total) * 100)
	}
	return out, nil
}

// ---------------- 网络 ----------------

// netBytes 解析 `netstat -ibn`。同一块网卡会有多行（Link / IPv4 / IPv6），
// 累计字节数每行都相同，所以按网卡名取最大值再求和，避免重复计数。
func netBytes() (rx, tx uint64, err error) {
	out, err := runCmd(5*time.Second, "netstat", "-ibn")
	if err != nil {
		return 0, 0, err
	}
	lines := strings.Split(out, "\n")
	if len(lines) < 2 {
		return 0, 0, fmt.Errorf("netstat 无数据")
	}

	var idxI, idxO = -1, -1
	for i, h := range strings.Fields(lines[0]) {
		switch h {
		case "Ibytes":
			idxI = i
		case "Obytes":
			idxO = i
		}
	}
	if idxI < 0 || idxO < 0 {
		return 0, 0, fmt.Errorf("netstat 表头未找到 Ibytes/Obytes")
	}

	per := map[string][2]uint64{}
	for _, line := range lines[1:] {
		f := strings.Fields(line)
		if len(f) <= idxI || len(f) <= idxO {
			continue
		}
		name := strings.TrimSuffix(f[0], "*")
		if strings.HasPrefix(name, "lo") {
			continue // 回环流量不代表真实网络状况
		}
		ib, ob := parseUint(f[idxI]), parseUint(f[idxO])
		cur := per[name]
		if ib > cur[0] {
			cur[0] = ib
		}
		if ob > cur[1] {
			cur[1] = ob
		}
		per[name] = cur
	}

	names := make([]string, 0, len(per))
	for n := range per {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		rx += per[n][0]
		tx += per[n][1]
	}
	if len(names) == 0 {
		return 0, 0, fmt.Errorf("netstat 未解析到任何网卡")
	}
	return rx, tx, nil
}

// ---------------- 进程 ----------------

// processList 用 ps 取全量进程名，再按配置里的名字做包含匹配。
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
	name := "macOS"
	if v, err := runCmd(3*time.Second, "sw_vers", "-productVersion"); err == nil && v != "" {
		name += " " + v
	}
	if k, err := runCmd(3*time.Second, "uname", "-r"); err == nil && k != "" {
		name += " (Darwin " + k + ")"
	}
	return name
}

func platformNotes() []string { return nil }
