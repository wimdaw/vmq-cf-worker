package wallet

import (
	"encoding/hex"
	"os/exec"
	"strings"
	"testing"
)

// 用本机真实通知记录验证解析器：从通知库里取一条，解出 titl/body。
func TestParseRealNotification(t *testing.T) {
	db, derr := notificationDBPath()
	if derr != nil {
		t.Skipf("没有可用的通知库: %v", derr)
	}
	out, err := exec.Command("sqlite3", db,
		"select hex(data) from record order by rec_id desc limit 1").Output()
	if err != nil {
		t.Skip("读不到通知库（可能没有完全磁盘访问权限）")
	}
	hexStr := strings.TrimSpace(string(out))
	if hexStr == "" {
		t.Skip("通知库为空")
	}
	raw := mustHex(t, hexStr)
	root, err := parseBPlist(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	title, body := plistNotice(root)
	if title == "" && body == "" {
		t.Fatalf("没解出标题/正文: %#v", root)
	}
	t.Logf("title=%q body=%q", title, body)
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
