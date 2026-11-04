package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/logging"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/wallet"
)

// walletRunner 把「账单轮询 → 去重 → 上报 /appPush」这条链路跑起来。
//
// 它是独立于采集循环的 goroutine：账单接口慢或挂掉，不应该影响
// CPU/内存这些系统指标的采集与告警 —— 这恰恰是最需要看到现场的时候。
type walletRunner struct {
	srcs []wallet.Source
	push *wallet.Pusher
	log  *logging.Logger
	poll time.Duration

	mu sync.Mutex
	st protocol.Wallet
}

func newWalletRunner(cfg *config.Config, log *logging.Logger) (*walletRunner, error) {
	if !cfg.Wallet.Enabled {
		return nil, nil
	}
	if cfg.Wallet.Alipay == nil {
		return nil, fmt.Errorf("wallet.enabled=true 但没有可用的账单源")
	}

	var srcs []wallet.Source
	if cfg.Wallet.Alipay != nil && cfg.Wallet.Alipay.Endpoint != "" {
		src, err := wallet.NewAlipayBill(*cfg.Wallet.Alipay, cfg.Timeout())
		if err != nil {
			return nil, err
		}
		srcs = append(srcs, src)
	}
	if cfg.Wallet.WeChat != nil {
		src, err := wallet.NewWeChat(*cfg.Wallet.WeChat, cfg.Timeout())
		if err != nil {
			return nil, err
		}
		srcs = append(srcs, src)
	}
	if len(srcs) == 0 {
		return nil, fmt.Errorf("没有可用的到账来源")
	}
	names := make([]string, 0, len(srcs))
	for _, s := range srcs {
		names = append(names, s.Name())
	}
	poll := time.Duration(cfg.Wallet.PollSec) * time.Second
	if poll < 10*time.Second {
		poll = 10 * time.Second // 太频繁会触发风控，也不会更快
	}

	return &walletRunner{
		srcs: srcs,
		push: wallet.NewPusher(cfg.Server.BaseURL, cfg.Server.Token, cfg.Wallet.PID, cfg.Timeout()),
		log:  log,
		poll: poll,
		st: protocol.Wallet{
			Enabled: true,
			Sources: names,
		},
	}, nil
}

func (w *walletRunner) run(ctx context.Context) {
	w.log.Infof("到账监控已启动：源=%v 通道=%s 间隔=%s", w.st.Sources, w.push.PID, w.poll)

	ticker := time.NewTicker(w.poll)
	defer ticker.Stop()

	w.tick(ctx) // 启动即拉一次，不等第一个 tick
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.tick(ctx)
		}
	}
}

func (w *walletRunner) tick(ctx context.Context) {
	pollCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var events []wallet.Event
	var firstErr error
	for _, src := range w.srcs {
		evs, err := src.Poll(pollCtx)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", src.Name(), err)
			}
			continue
		}
		events = append(events, evs...)
	}
	if firstErr != nil {
		w.setErr(firstErr)
		w.log.Warnf("到账来源拉取失败: %v", firstErr)
	}

	w.mu.Lock()
	w.st.LastPollTS = time.Now().Unix()
	if firstErr == nil {
		w.st.LastError = ""
		w.st.LastOKTS = w.st.LastPollTS
		w.st.ErrStreak = 0
	} else {
		w.st.ErrStreak++
	}
	w.mu.Unlock()

	for _, ev := range events {
		msg, err := w.push.Push(ctx, ev)
		if err != nil {
			w.setErr(err)
			w.log.Errorf("上报到账失败 %.2s 元: %v", ev.Money, err)
			continue
		}

		w.mu.Lock()
		w.st.PushedTotal++
		w.st.LastEventTS = ev.TS
		w.st.LastMoney = ev.Money
		w.st.LastMsg = msg
		w.st.LastError = ""
		w.mu.Unlock()

		w.log.Infof("识别到账 %s 元（%s）→ %s", ev.Money, ev.Source, msg)
	}
}

func (w *walletRunner) setErr(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.st.LastError = err.Error()
}

// metrics 把到账链路的健康度并进指标表，交给规则引擎判定。
//
// 这两个值回答的是「到账这条路还通不通」：
// 轮询停滞（窗口读不到 / cookie 过期 / 接口被封）和连续失败次数。
// 只看「有没有到账」会误报 —— 没人付款时本来就没有到账。
func (w *walletRunner) metrics(now int64) map[string]float64 {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()

	out := map[string]float64{
		protocol.MetricWalletErrStreak: float64(w.st.ErrStreak),
	}
	// 还没成功过时用启动后的第一次轮询时间兜底，避免一启动就报「停滞」
	ref := w.st.LastOKTS
	if ref == 0 {
		ref = w.st.LastPollTS
	}
	if ref > 0 {
		age := now - ref
		if age < 0 {
			age = 0
		}
		out[protocol.MetricWalletPollAge] = float64(age)
	}
	return out
}

// snapshot 供上报使用；没有启用时返回 nil（omitempty 会把整段省略）。
func (w *walletRunner) snapshot() *protocol.Wallet {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	cp := w.st
	return &cp
}

// runWalletProbe 是 `-wallet-probe` 的实现。
//
// 不猜外部结构：把每个已配置来源的**原始数据**打出来，再附上按当前配置的解析结果。
// 支付宝接口变了、微信窗口层级变了，跑一次就能看清并自助校准。
func runWalletProbe(cfg *config.Config) {
	type probeItem struct {
		name string
		dbg  wallet.Debugger
	}
	var items []probeItem
	var errs []string

	if cfg.Wallet.Alipay != nil && cfg.Wallet.Alipay.Endpoint != "" {
		if src, err := wallet.NewAlipayBill(*cfg.Wallet.Alipay, cfg.Timeout()); err != nil {
			errs = append(errs, "alipay: "+err.Error())
		} else {
			items = append(items, probeItem{"alipay-bill", src})
		}
	}
	if cfg.Wallet.WeChat != nil {
		if src, err := wallet.NewWeChat(*cfg.Wallet.WeChat, cfg.Timeout()); err != nil {
			errs = append(errs, "wechat: "+err.Error())
		} else if d, ok := src.(wallet.Debugger); ok {
			items = append(items, probeItem{src.Name(), d})
		}
	}

	for _, e := range errs {
		fmt.Fprintf(os.Stderr, "跳过 %s\n", e)
	}
	if len(items) == 0 {
		fmt.Println("没有可探测的到账来源。请先填 wallet.alipay.endpoint 或 wallet.wechat。")
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	failed := false
	for _, it := range items {
		fmt.Printf("\n===== %s =====\n", it.name)
		out, err := it.dbg.Debug(ctx)
		fmt.Println(out)
		if err != nil {
			fmt.Printf("--- 出错 ---\n%v\n", err)
			failed = true
		}
	}
	if failed {
		os.Exit(2)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
