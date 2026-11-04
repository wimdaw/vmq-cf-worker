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
// 支付宝账单接口没有公开文档，所以这里不做任何猜测：原样打印服务端返回，
// 再按当前配置试着解析一遍。使用者据此校准 items_path / field_* / pattern。
func runWalletProbe(cfg *config.Config) {
	if cfg.Wallet.Alipay == nil || cfg.Wallet.Alipay.Endpoint == "" {
		fmt.Println("配置里没有 wallet.alipay.endpoint，无从探测。")
		fmt.Println("请先在配置文件里填上账单接口地址与 cookie（或设 VMQ_ALIPAY_COOKIE 环境变量）。")
		os.Exit(1)
	}

	src, err := wallet.NewAlipayBill(*cfg.Wallet.Alipay, cfg.Timeout())
	if err != nil {
		fmt.Fprintf(os.Stderr, "构建账单源失败: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	fmt.Printf("探测 %s\n", cfg.Wallet.Alipay.Endpoint)
	raw, items, perr := src.Probe(ctx)

	fmt.Printf("\n--- 原始返回（前 2000 字节）---\n%s\n", truncate(string(raw), 2000))

	if perr != nil {
		fmt.Printf("\n--- 解析失败 ---\n%v\n", perr)
		fmt.Println("\n提示：把上面的结构对照回来，填 items_path / field_money / field_time；")
		fmt.Println("      如果是 HTML 页面，改用 \"parser\": \"regex\" 并用命名分组 money/time/title。")
		os.Exit(2)
	}

	fmt.Printf("\n--- 按当前配置解析到 %d 条 ---\n", len(items))
	for i, it := range items {
		if i >= 10 {
			fmt.Printf("  … 其余 %d 条省略\n", len(items)-10)
			break
		}
		fmt.Printf("  %-12s %-10s %s\n", it.Money, it.TimeText, truncate(it.Title, 40))
	}
	if len(items) == 0 {
		fmt.Println("  一条都没解析出来：检查 items_path 是否指到数组，field_money 是否正确。")
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
