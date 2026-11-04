//go:build darwin

package wallet

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// WeChatNotify 读 macOS 通知中心数据库，取出微信的到账通知。
//
// 这是「监听通知」在桌面上的唯一可行形态：macOS 没有公开的通知订阅 API，
// 但通知内容会落进 usernoted 的 SQLite。读它需要「完全磁盘访问」权限
// （系统设置 → 隐私与安全性 → 完全磁盘访问），否则 sqlite3 会报无法打开。
type WeChatNotify struct {
	cfg       WeChatCfg
	dbPath    string
	lastRecID int64
	dedup     *Deduper
	timeout   time.Duration
}

// notificationDBPath 定位通知库。
//
// 它在 $TMPDIR 的**兄弟目录**下：TMPDIR 是 /var/folders/<x>/<y>/T/，
// 库在 /var/folders/<x>/<y>/0/com.apple.notificationcenter/db2/db。
// 由于这段路径带随机串，每次启动都要现算，不能写死。
func notificationDBPath() (string, error) {
	if v := os.Getenv("VMQ_NOTIFY_DB"); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
		return "", fmt.Errorf("VMQ_NOTIFY_DB 指向的文件不存在: %s", v)
	}

	dir := os.Getenv("TMPDIR")
	if dir == "" {
		dir = os.TempDir()
	}
	dir = filepath.Clean(dir)
	rel := filepath.Join("com.apple.notificationcenter", "db2", "db")

	candidates := []string{
		filepath.Join(dir, rel),                    // 老版本直接放在 TMPDIR 下
		filepath.Join(filepath.Dir(dir), "0", rel), // macOS 12+ 在 TMPDIR 的兄弟目录 0/
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	// 兜底：TMPDIR 可能被改过，直接在 /var/folders 下找
	if m, _ := filepath.Glob("/var/folders/*/*/0/" + filepath.ToSlash(rel)); len(m) > 0 {
		return m[0], nil
	}
	return "", fmt.Errorf("找不到通知数据库（尝试过 %s；macOS 12+ 需要「完全磁盘访问」权限）",
		strings.Join(candidates, "、"))
}

func newWeChat(cfg WeChatCfg, timeout time.Duration) (Source, error) {
	db, err := notificationDBPath()
	if err != nil {
		return nil, err
	}
	if _, err := exec.LookPath("sqlite3"); err != nil {
		return nil, fmt.Errorf("未找到 sqlite3，无法读取通知库")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &WeChatNotify{
		cfg:     cfg,
		dbPath:  db,
		dedup:   NewDeduper(time.Hour),
		timeout: timeout,
	}, nil
}

func (s *WeChatNotify) Name() string { return "wechat-notify" }

func (s *WeChatNotify) Platform() int { return TypeWeChat }

func (s *WeChatNotify) PID() string { return s.cfg.PID }

func (s *WeChatNotify) Poll(ctx context.Context) ([]Event, error) {
	rows, err := s.queryNew(ctx)
	if err != nil {
		return nil, err
	}

	var out []Event
	for _, r := range rows {
		plist, err := hex.DecodeString(strings.TrimSpace(r.hex))
		if err != nil {
			continue
		}
		root, err := parseBPlist(plist)
		if err != nil {
			continue
		}
		title, body := plistNotice(root)
		if !s.interesting(title + " " + body) {
			continue
		}
		money := ExtractMoney(body + " " + title)
		if money == "" {
			continue
		}
		key := fmt.Sprintf("%d|%s|%s", r.date, title, body)
		if s.dedup.SeenBefore(key) {
			continue
		}
		out = append(out, Event{
			Platform: "wechat",
			Type:     TypeWeChat,
			Money:    money,
			Raw:      strings.TrimSpace(title + " | " + body),
			Source:   s.Name(),
			TS:       r.date,
		})
	}
	return out, nil
}

type notifyRow struct {
	recID int64
	date  int64
	hex   string
}

// queryNew 只取上次之后的新记录，避免每次全表扫。
func (s *WeChatNotify) queryNew(ctx context.Context) ([]notifyRow, error) {
	apps := s.cfg.AppList()
	quoted := make([]string, 0, len(apps))
	for _, a := range apps {
		quoted = append(quoted, "'"+strings.ReplaceAll(a, "'", "''")+"'")
	}
	sql := fmt.Sprintf(
		`SELECT r.rec_id, CAST(r.delivered_date AS INTEGER), hex(r.data)
		 FROM record r JOIN app a ON a.app_id = r.app_id
		 WHERE a.identifier IN (%s) AND r.rec_id > %d
		 ORDER BY r.rec_id LIMIT 200`,
		strings.Join(quoted, ","), s.lastRecID)

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sqlite3", "-separator", "\t", s.dbPath, sql)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("读取通知库失败（需要「完全磁盘访问」权限）: %w", err)
	}

	var rows []notifyRow
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		id, _ := strconv.ParseInt(parts[0], 10, 64)
		// delivered_date 是 Core Data 时间戳（自 2001-01-01 的秒数），要加偏移才是 Unix
		raw, _ := strconv.ParseInt(parts[1], 10, 64)
		ts := int64(0)
		if raw > 0 {
			ts = raw + 978307200
		}
		rows = append(rows, notifyRow{recID: id, date: ts, hex: parts[2]})
		if id > s.lastRecID {
			s.lastRecID = id
		}
	}
	return rows, nil
}

func (s *WeChatNotify) interesting(text string) bool {
	for _, k := range s.cfg.KeywordList() {
		if strings.Contains(text, k) {
			return true
		}
	}
	return false
}

// plistNotice 从通知负载里取标题与正文。
// 结构形如 { "req": { "titl": "...", "body": "..." }, "app": "..." }。
func plistNotice(root any) (title, body string) {
	m, ok := root.(map[string]any)
	if !ok {
		return "", ""
	}
	req, ok := m["req"].(map[string]any)
	if !ok {
		return "", ""
	}
	if v, ok := req["titl"].(string); ok {
		title = v
	}
	if v, ok := req["body"].(string); ok {
		body = v
	}
	return title, body
}
