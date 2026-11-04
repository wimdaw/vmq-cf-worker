package wallet

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// AlipayBillCfg 是支付宝账单源的配置。
//
// 刻意**不内置任何默认接口地址**：支付宝网页版/商家中心的账单接口没有公开文档，
// 路径与返回结构随版本变化，硬编码一个猜出来的地址只会让人以为能用、
// 实际静默失败。正确用法是先 `vmq-agent -wallet-probe` 用真实登录态抓一次，
// 看清结构再填 parser 相关字段（见 docs/monitor-desktop.md）。
type AlipayBillCfg struct {
	Endpoint  string            `json:"endpoint"`
	Method    string            `json:"method,omitempty"` // GET / POST，默认 GET
	Cookie    string            `json:"cookie,omitempty"`
	Referer   string            `json:"referer,omitempty"`
	UserAgent string            `json:"user_agent,omitempty"`
	Body      string            `json:"body,omitempty"`    // POST 表单体，原样发送
	Headers   map[string]string `json:"headers,omitempty"` // 额外请求头

	// 解析方式：json / regex
	Parser string `json:"parser,omitempty"`

	// json 解析：列表所在的点号路径，例如 "data.list"；留空表示根就是数组
	ItemsPath  string `json:"items_path,omitempty"`
	FieldTime  string `json:"field_time,omitempty"`
	FieldMoney string `json:"field_money,omitempty"`
	FieldTitle string `json:"field_title,omitempty"`
	TimeFormat string `json:"time_format,omitempty"`

	// regex 解析：整页 HTML 里逐条匹配，用命名分组 money / time / title
	Pattern string `json:"pattern,omitempty"`

	// 只处理多少分钟内的账单，避免把历史全部重推一遍
	WindowMin int `json:"window_min,omitempty"`
}

// AlipayBill 轮询支付宝账单。
//
// 这是三平台**完全一致**的实现：纯 HTTP + cookie，与操作系统无关。
// 手机端靠通知，桌面端靠账单，最终产出同一种 Event。
type AlipayBill struct {
	cfg    AlipayBillCfg
	client *http.Client
	dedup  *Deduper
	re     *regexp.Regexp
}

func NewAlipayBill(cfg AlipayBillCfg, timeout time.Duration) (*AlipayBill, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, fmt.Errorf("wallet.alipay.endpoint 未配置")
	}
	if cfg.Method == "" {
		cfg.Method = http.MethodGet
	}
	if cfg.Parser == "" {
		cfg.Parser = "json"
	}
	if cfg.WindowMin <= 0 {
		cfg.WindowMin = 15
	}
	if cfg.TimeFormat == "" {
		cfg.TimeFormat = "2006-01-02 15:04:05"
	}

	b := &AlipayBill{
		cfg:    cfg,
		client: &http.Client{Timeout: timeout},
		dedup:  NewDeduper(2 * time.Hour),
	}

	if cfg.Parser == "regex" {
		if cfg.Pattern == "" {
			return nil, fmt.Errorf("parser=regex 时必须配置 pattern")
		}
		re, err := regexp.Compile(cfg.Pattern)
		if err != nil {
			return nil, fmt.Errorf("pattern 编译失败: %w", err)
		}
		b.re = re
	} else if cfg.Parser != "json" {
		return nil, fmt.Errorf("parser 只能是 json 或 regex，当前 %s", cfg.Parser)
	}
	return b, nil
}

func (b *AlipayBill) Name() string { return "alipay-bill" }

func (b *AlipayBill) Platform() int { return TypeAlipay }

// Fetch 发一次请求，返回原始响应体。Probe 与 Poll 共用，保证探测到的
// 就是运行时真正拿到的东西 —— 探测走另一套请求逻辑是自欺欺人。
func (b *AlipayBill) Fetch(ctx context.Context) ([]byte, error) {
	var body io.Reader
	if b.cfg.Method == http.MethodPost && b.cfg.Body != "" {
		body = strings.NewReader(b.cfg.Body)
	}
	req, err := http.NewRequestWithContext(ctx, b.cfg.Method, b.cfg.Endpoint, body)
	if err != nil {
		return nil, err
	}

	if b.cfg.Method == http.MethodPost {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	}
	if b.cfg.Cookie != "" {
		req.Header.Set("Cookie", b.cfg.Cookie)
	}
	if b.cfg.Referer != "" {
		req.Header.Set("Referer", b.cfg.Referer)
	} else if u, err := url.Parse(b.cfg.Endpoint); err == nil {
		req.Header.Set("Referer", u.Scheme+"://"+u.Host+"/")
	}
	ua := b.cfg.UserAgent
	if ua == "" {
		ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	for k, v := range b.cfg.Headers {
		req.Header.Set(k, v)
	}

	resp, err := b.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return raw, fmt.Errorf("HTTP %d（登录态可能已失效）", resp.StatusCode)
	}
	return raw, nil
}

// Poll 拉一次账单并返回新事件。
func (b *AlipayBill) Poll(ctx context.Context) ([]Event, error) {
	raw, err := b.Fetch(ctx)
	if err != nil {
		return nil, err
	}

	recs, err := b.parse(raw)
	if err != nil {
		return nil, err
	}

	cutoff := time.Now().Add(-time.Duration(b.cfg.WindowMin) * time.Minute).Unix()
	var out []Event
	for _, r := range recs {
		money := ExtractMoney(r.Money)
		if money == "" {
			continue
		}
		// 时间拿不到就不做窗口过滤（宁可多报，交给服务端金额池判定）
		if r.TS > 0 && r.TS < cutoff {
			continue
		}
		key := fmt.Sprintf("%d|%s|%s", r.TS, money, r.Title)
		if b.dedup.SeenBefore(key) {
			continue
		}
		out = append(out, Event{
			Platform: "alipay",
			Type:     TypeAlipay,
			Money:    money,
			Raw:      fmt.Sprintf("%s %s %s", r.Title, money, r.Money),
			Source:   b.Name(),
			TS:       r.TS,
		})
	}
	return out, nil
}

type billRecord struct {
	Money string
	Title string
	TS    int64
}

func (b *AlipayBill) parse(raw []byte) ([]billRecord, error) {
	if b.cfg.Parser == "regex" {
		return b.parseRegex(string(raw))
	}
	return b.parseJSON(raw)
}

func (b *AlipayBill) parseJSON(raw []byte) ([]billRecord, error) {
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("响应不是 JSON（用 -wallet-probe 看真实返回，或改用 parser=regex）: %w", err)
	}

	items := collectMaps(root, b.cfg.ItemsPath)
	recs := make([]billRecord, 0, len(items))
	for _, m := range items {
		rec := billRecord{
			Money: asString(pickFirst(m, b.cfg.FieldMoney)),
			Title: asString(pickFirst(m, b.cfg.FieldTitle)),
		}
		if s := asString(pickFirst(m, b.cfg.FieldTime)); s != "" {
			rec.TS = parseTime(s, b.cfg.TimeFormat)
		}
		recs = append(recs, rec)
	}
	return recs, nil
}

func (b *AlipayBill) parseRegex(text string) ([]billRecord, error) {
	ms := b.re.FindAllStringSubmatch(text, 500)
	if len(ms) == 0 {
		return nil, nil
	}
	names := b.re.SubexpNames()
	var recs []billRecord
	for _, m := range ms {
		rec := billRecord{}
		for i, name := range names {
			if i == 0 || i >= len(m) {
				continue
			}
			switch name {
			case "money":
				rec.Money = m[i]
			case "title":
				rec.Title = m[i]
			case "time":
				rec.TS = parseTime(m[i], b.cfg.TimeFormat)
			}
		}
		recs = append(recs, rec)
	}
	return recs, nil
}

/* ---------------------------- 小工具 ---------------------------- */

// collectMaps 按点号路径取出列表。路径为空时把根当列表。
// 支持数组在任意层级被展开（例如 data.list、data.rows）。
func collectMaps(root any, path string) []map[string]any {
	node := root
	if path != "" {
		for _, key := range strings.Split(path, ".") {
			m, ok := node.(map[string]any)
			if !ok {
				return nil
			}
			node, ok = m[key]
			if !ok {
				return nil
			}
		}
	}

	var out []map[string]any
	switch v := node.(type) {
	case []any:
		for _, e := range v {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
	case map[string]any:
		out = append(out, v)
	}
	return out
}

// pickFirst 在该条目内按点号路径取值（例如 "trade.amount"）。
func pickFirst(m map[string]any, path string) any {
	if path == "" {
		return nil
	}
	var node any = m
	for _, key := range strings.Split(path, ".") {
		mm, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node, ok = mm[key]
		if !ok {
			return nil
		}
	}
	return node
}

func asString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(x)
	case float64:
		// 金额常见为数字：固定两位，避免 18.1 这种丢零后签名对不上
		return strconv.FormatFloat(x, 'f', 2, 64)
	case json.Number:
		return x.String()
	default:
		return fmt.Sprint(x)
	}
}

// parseTime 容忍几种常见写法；解析不出来返回 0（上层不做时间窗口过滤）。
func parseTime(s, layout string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
		return t.Unix()
	}
	for _, alt := range []string{
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006/01/02 15:04:05",
		"01-02 15:04",
	} {
		if t, err := time.ParseInLocation(alt, s, time.Local); err == nil {
			return t.Unix()
		}
	}
	return 0
}

/* ------------------------------ 探测模式 ------------------------------ */

// Preview 是探测模式返回的一条解析结果，只用于人工核对，不参与去重与上报。
type Preview struct {
	Money    string `json:"money"`
	Title    string `json:"title"`
	TS       int64  `json:"ts"`
	TimeText string `json:"time_text"`
}

// Debug 实现 Debugger 接口，输出原始响应 + 解析摘要。
func (b *AlipayBill) Debug(ctx context.Context) (string, error) {
	raw, items, err := b.Probe(ctx)
	var sb strings.Builder
	sb.WriteString("--- 原始返回（前 2000 字节）---\n")
	sb.WriteString(truncateStr(string(raw), 2000))
	sb.WriteString("\n")
	if err != nil {
		return sb.String(), err
	}
	sb.WriteString(fmt.Sprintf("\n--- 按当前配置解析到 %d 条 ---\n", len(items)))
	for i, it := range items {
		if i >= 10 {
			sb.WriteString(fmt.Sprintf("  … 其余 %d 条省略\n", len(items)-10))
			break
		}
		sb.WriteString(fmt.Sprintf("  %-12s %-20s %s\n", it.Money, it.TimeText, truncateStr(it.Title, 40)))
	}
	if len(items) == 0 {
		sb.WriteString("  一条都没解析出来：检查 items_path 是否指到数组，field_money 是否正确。\n")
	}
	return sb.String(), nil
}

// Probe 拉一次并解析，返回原始响应与解析结果。
//
// 为什么要有这个：支付宝账单接口没有公开文档，路径与结构随版本变化。
// 与其猜一个默认值让它静默失败，不如让使用者用真实登录态抓一次，
// 看清结构后再填 items_path / field_* —— 五分钟的事，换来的是「确实能用」。
func (b *AlipayBill) Probe(ctx context.Context) (raw []byte, out []Preview, err error) {
	raw, err = b.Fetch(ctx)
	if err != nil {
		return raw, nil, err
	}
	recs, perr := b.parse(raw)
	if perr != nil {
		return raw, nil, perr
	}
	for _, r := range recs {
		out = append(out, Preview{
			Money: ExtractMoney(r.Money),
			Title: r.Title,
			TS:    r.TS,
			TimeText: func() string {
				if r.TS == 0 {
					return ""
				}
				return time.Unix(r.TS, 0).Format("2006-01-02 15:04:05")
			}(),
		})
	}
	return raw, out, nil
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
