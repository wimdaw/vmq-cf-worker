//go:build !windows

package collect

import "os/exec"

// hideWindow 在 Unix 上没有「控制台窗口」这回事，空实现。
func hideWindow(cmd *exec.Cmd) {}
