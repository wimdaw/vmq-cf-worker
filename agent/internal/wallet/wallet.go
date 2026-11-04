// Package wallet 是桌面端的「到账事件源」抽象。
//
// 背景：手机端（monitor-android）靠 NotificationListenerService 读通知栏，
// 这条路在桌面上不存在（Windows/macOS/Linux 都没有公开 API 订阅别的 App 的通知）。
// 但 V免签 早期的 PC 监控端确实做到过，用的是两条完全不同的路：
//
//	微信   —— 登录 PC 微信，读「微信收款助手」推来的到账消息
//	支付宝 —— 登录阿里旺旺拿到 SSO 登录态，再读支付宝网页版的账单
//
// 本包把这两条路抽象成统一的 Source：不管事件从通知来还是从账单来，
// 最终都变成同一个 Event，走同一套金额提取、去重和 /appPush 上报。
// 这样「三端功能一致」在桌面侧依然成立 —— 差异被收敛在 Source 实现里。
package wallet

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 支付平台在 V免签 里的类型编号，与手机端 Rules.kt 完全一致。
const (
	TypeWeChat = 1
	TypeAlipay = 2
	TypeDCEP   = 4
)

// Event 是一条「疑似到账」。
//
// 只保留服务端 /appPush 需要的东西 + 排障用的原文。
// Source 字段用于区分来源（notify / bill），出问题时能立刻判断是哪条链路。
type Event struct {
	Platform string // wechat / alipay
	Type     int    // 1 / 2 / 4
	Money    string // 原始字符串（"18.01"），不能是 18.1
	Raw      string // 原始文本，进日志与告警，便于回溯
	Source   string // notify / bill
	TS       int64
}

// Source 是一个到账事件源。Poll 返回「自上次调用以来的新事件」。
//
// 去重责任在实现方：账单接口通常会返回一页历史，必须自己记住处理过哪些。
type Source interface {
	// Name 用于日志与配置对照，例如 "alipay-bill"
	Name() string
	// Platform 返回该源对应的支付平台类型（TypeWeChat / TypeAlipay）
	Platform() int
	Poll(ctx context.Context) ([]Event, error)
}

// WeChatCfg 是微信通知源的配置。三平台字段一致，实现不同。
type WeChatCfg struct {
	// Mode: window（默认，读微信窗口文本）/ notify（读 macOS 通知中心）
	Mode     string   `json:"mode,omitempty"`
	Apps     []string `json:"apps,omitempty"`
	Keywords []string `json:"keywords,omitempty"`
}

func (c *WeChatCfg) AppList() []string {
	if len(c.Apps) > 0 {
		return c.Apps
	}
	return []string{"com.tencent.xinWeChat"}
}

func (c *WeChatCfg) KeywordList() []string {
	if len(c.Keywords) > 0 {
		return c.Keywords
	}
	// 覆盖「微信支付」「微信收款助手」「微信收款商业版」的常见文案
	return []string{"收款", "到账", "收到转账", "微信支付"}
}

// NewWeChat 按 mode 选择实现。
//
// 默认走 window：微信到账是**服务号会话消息**，不一定写系统通知中心，
// 读窗口才是主路径（与 wxauto 的做法一致）。
// notify 仅 macOS 可用，作为「窗口读不到但通知能读到」时的兜底。
func NewWeChat(cfg WeChatCfg, timeout time.Duration) (Source, error) {
	if cfg.Mode == "notify" {
		return newWeChat(cfg, timeout)
	}
	return newWeChatWindow(cfg, timeout)
}

// Debugger 是「可以被 -wallet-probe 探测」的源。
// 探测的价值在于：外部接口/窗口结构随时会变，能一次看清原始数据就能自助校准。
type Debugger interface {
	Debug(ctx context.Context) (string, error)
}

/* ------------------------------ 金额提取 ------------------------------ */

// moneyRe 与手机端 Rules.kt 保持同一个口径：两位小数。
//
// 不用「最后一个匹配」：到账文案里常带余额（「收款 18.01 元，余额 1234.56 元」），
// 取最后一个会拿到余额，这是免签系统最常见的错账来源。
var moneyRe = regexp.MustCompile(`(\d+\.\d{2})`)

// 单笔金额的合理区间，防止把时间戳、订单号里的数字当成金额。
const (
	minMoney = 0.01
	maxMoney = 100000
)

// ExtractMoney 从一段文本里取出第一个合法金额。
func ExtractMoney(text string) string {
	for _, m := range moneyRe.FindAllString(text, -1) {
		v, err := strconv.ParseFloat(m, 64)
		if err != nil {
			continue
		}
		if v < minMoney || v > maxMoney {
			continue
		}
		return m
	}
	return ""
}

/* ------------------------------ 去重 ------------------------------ */

// Deduper 是「窗口内出现过的所有 key」式去重，与手机端 NoticeDeduper 一致。
//
// 只记最后一条会在 A → B → A 这种交错场景漏判第二个 A。
// 账单轮询天然会重复读到同一页，所以去重是必须的，不是优化。
type Deduper struct {
	mu   sync.Mutex
	seen map[string]time.Time
	ttl  time.Duration
}

func NewDeduper(ttl time.Duration) *Deduper {
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	return &Deduper{seen: map[string]time.Time{}, ttl: ttl}
}

// SeenBefore 记录 key 并返回它此前是否已出现过。
func (d *Deduper) SeenBefore(key string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	for k, at := range d.seen {
		if now.Sub(at) > d.ttl {
			delete(d.seen, k)
		}
	}
	if _, ok := d.seen[key]; ok {
		return true
	}
	d.seen[key] = now
	return false
}

/* ------------------------------ 上报 ------------------------------ */

// Pusher 负责把 Event 变成一次 /appPush 调用。
//
// 复用手机端协议的好处：服务端完全不用改。金额池匹配、状态条件校验、
// 商户回调、幂等全都在服务端已经实现，桌面端只是「另一个上报方」。
//
// 签名：md5(type + price + t + pid + key)，与 monitor-android 的 Signer 一致。
type Pusher struct {
	BaseURL string
	Token   string // 通讯密钥
	PID     string // 通道 ID
	Client  *http.Client
}

func NewPusher(baseURL, token, pid string, timeout time.Duration) *Pusher {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Pusher{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		PID:     pid,
		Client:  &http.Client{Timeout: timeout},
	}
}

// Sign 计算上报签名。price 必须用原始字符串，转成 float 再格式化会丢尾零。
func Sign(typ int, price, t, pid, key string) string {
	sum := md5.Sum([]byte(strconv.Itoa(typ) + price + t + pid + key))
	return hex.EncodeToString(sum[:])
}

// Push 上报一条到账。返回服务端的 msg，便于日志直接展示。
func (p *Pusher) Push(ctx context.Context, ev Event) (string, error) {
	if p.PID == "" {
		return "", fmt.Errorf("未配置通道 ID（wallet.pid），无法上报")
	}
	ts := strconv.FormatInt(ev.TS, 10)
	if ev.TS <= 0 {
		ts = strconv.FormatInt(time.Now().Unix(), 10)
	}
	sign := Sign(ev.Type, ev.Money, ts, p.PID, p.Token)

	q := fmt.Sprintf("%s/appPush?type=%d&price=%s&t=%s&pid=%s&sign=%s",
		p.BaseURL, ev.Type, ev.Money, ts, p.PID, sign)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, q, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "vmq-agent/wallet")

	resp, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body := make([]byte, 4096)
	n, _ := resp.Body.Read(body)
	text := strings.TrimSpace(string(body[:n]))
	if resp.StatusCode != http.StatusOK {
		return text, fmt.Errorf("HTTP %d: %s", resp.StatusCode, text)
	}
	return text, nil
}
