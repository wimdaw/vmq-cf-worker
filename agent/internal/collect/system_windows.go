package collect

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

// hideWindow 让采集时调用的 tasklist/PowerShell 不弹出黑色控制台窗口。
// 作为服务运行时本来就没有会话，但手动运行和计划任务方式下这个很影响观感。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetDiskFreeSpaceExW  = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
)

type filetime struct {
	LowDateTime  uint32
	HighDateTime uint32
}

func (f filetime) u64() uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }

// ---------------- CPU ----------------

// platformCPU 两次调 GetSystemTimes 求差。
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
		return 0, fmt.Errorf("GetSystemTimes 计数未推进")
	}
	dt := float64(total2 - total1)
	di := float64(idle2 - idle1)
	return (dt - di) / dt * 100, nil
}

// cpuTimes 调 GetSystemTimes 拿三个累计 FILETIME（单位 100ns）。
// 注意 kernel 时间里**已经包含 idle**，所以未空闲时间 = kernel+user-idle，
// total 直接取 kernel+user 即可。
func cpuTimes() (idle, total uint64, err error) {
	var i, k, u filetime
	r, _, e := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&i)),
		uintptr(unsafe.Pointer(&k)),
		uintptr(unsafe.Pointer(&u)),
	)
	if r == 0 {
		return 0, 0, fmt.Errorf("GetSystemTimes 失败: %v", e)
	}
	idle = i.u64()
	total = k.u64() + u.u64()
	if total == 0 {
		return 0, 0, fmt.Errorf("GetSystemTimes 返回全 0")
	}
	return idle, total, nil
}

// loadAvg：Windows 没有 load average 概念，明确返回 false。
// 上层会把这三个字段留空（omitempty），而不是填 0 —— 0 会被误读成「完全没负载」。
func loadAvg() (float64, float64, float64, bool) { return 0, 0, 0, false }

func uptime() (time.Duration, error) {
	r, _, e := procGetTickCount64.Call()
	if r == 0 {
		return 0, fmt.Errorf("GetTickCount64 失败: %v", e)
	}
	return time.Duration(r) * time.Millisecond, nil
}

// ---------------- 内存 ----------------

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func memUsageOf() (memUsage, error) {
	var ms memoryStatusEx
	ms.Length = uint32(unsafe.Sizeof(ms))
	r, _, e := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms)))
	if r == 0 {
		return memUsage{}, fmt.Errorf("GlobalMemoryStatusEx 失败: %v", e)
	}
	out := memUsage{total: ms.TotalPhys, available: ms.AvailPhys}

	// Windows 的 TotalPageFile 含物理内存，虚拟内存要减掉才算「交换区」
	if ms.TotalPageFile > ms.TotalPhys {
		out.swapTotal = ms.TotalPageFile - ms.TotalPhys
		usedPhys := ms.TotalPhys - ms.AvailPhys
		if ms.TotalPageFile > ms.AvailPageFile+usedPhys {
			out.swapUsed = ms.TotalPageFile - ms.AvailPageFile - usedPhys
		}
		if out.swapUsed > out.swapTotal {
			out.swapUsed = out.swapTotal
		}
	}
	return out, nil
}

// ---------------- 磁盘 ----------------

func diskUsage(mount string) (protocol.Disk, error) {
	p, err := syscall.UTF16PtrFromString(mount)
	if err != nil {
		return protocol.Disk{}, err
	}
	var freeAvail, total, totalFree uint64
	r, _, e := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeAvail)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return protocol.Disk{}, fmt.Errorf("GetDiskFreeSpaceEx %s 失败: %v", mount, e)
	}
	out := protocol.Disk{Mount: mount, TotalBytes: total, FreeBytes: freeAvail}
	if total > 0 {
		out.UsedPct = round2(float64(total-freeAvail) / float64(total) * 100)
	}
	return out, nil
}

// ---------------- 网络 ----------------

type adapterStat struct {
	ReceivedBytes uint64 `json:"ReceivedBytes"`
	SentBytes     uint64 `json:"SentBytes"`
}

// netBytes 走 PowerShell 的 Get-NetAdapterStatistics。
// Windows 没有像 /proc/net/dev 那种稳定文本接口，用 CIM 要处理复杂结构体，
// 这里选 PowerShell 是权衡后的结果：拿不到就返回错误，上层会把 net 字段整块省略，
// 不会用 0 冒充「没有流量」。
func netBytes() (rx, tx uint64, err error) {
	out, err := runCmd(10*time.Second, "powershell", "-NoProfile", "-NonInteractive",
		"-Command", "Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress")
	if err != nil {
		return 0, 0, err
	}
	out = strings.TrimSpace(out)
	if out == "" || out == "null" {
		return 0, 0, fmt.Errorf("Get-NetAdapterStatistics 无数据")
	}

	var arr []adapterStat
	if err := json.Unmarshal([]byte(out), &arr); err != nil {
		// 只有一块网卡时 ConvertTo-Json 给的是对象而不是数组
		var one adapterStat
		if err2 := json.Unmarshal([]byte(out), &one); err2 != nil {
			return 0, 0, fmt.Errorf("解析网卡统计失败: %w", err)
		}
		arr = []adapterStat{one}
	}
	for _, a := range arr {
		rx += a.ReceivedBytes
		tx += a.SentBytes
	}
	return rx, tx, nil
}

// ---------------- 进程 ----------------

// processList 用 tasklist 输出 CSV，交给 encoding/csv 解析 ——
// 进程名里带逗号的情况虽然罕见，但手工切分字符串迟早会在某个中文路径上翻车。
func processList(names []string) ([]protocol.Proc, error) {
	out, err := runCmd(10*time.Second, "tasklist", "/FO", "CSV", "/NH")
	if err != nil {
		return nil, err
	}
	r := csv.NewReader(strings.NewReader(out))
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	rows := make([]procRow, 0, len(records))
	for _, rec := range records {
		if len(rec) < 2 {
			continue
		}
		rows = append(rows, procRow{
			Name: filepath.Base(strings.TrimSpace(rec[0])),
			PID:  int(parseUint(rec[1])),
		})
	}
	return matchProcs(names, rows), nil
}

// ---------------- 系统信息 ----------------

func osVersion() string {
	out, err := runCmd(5*time.Second, "cmd", "/c", "ver")
	if err != nil {
		return "Windows"
	}
	// Microsoft Windows [Version 10.0.22631.4317]
	if i := strings.Index(out, "[Version "); i >= 0 {
		v := strings.TrimSuffix(out[i+len("[Version "):], "]")
		return "Windows " + strings.TrimSpace(v)
	}
	return strings.TrimSpace(out)
}

func platformNotes() []string {
	var notes []string
	if _, err := exec.LookPath("powershell"); err != nil {
		notes = append(notes, "未找到 powershell，网络吞吐与桌面弹窗不可用（其余指标不受影响）")
	}
	if strings.TrimSpace(os.Getenv("SESSIONNAME")) == "" {
		notes = append(notes, "当前无交互式桌面会话（以服务方式运行），桌面弹窗会跳过，告警请配置 webhook")
	}
	return notes
}
