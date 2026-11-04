// vmq-agent 是 V免签 的桌面监控端（Windows / macOS / Linux）。
//
// 一份代码三种平台：平台差异只落在 internal/collect 与 internal/alert 的
// 几个平台上，采集口径、规则、告警、上报全部共享。
//
// 用法：
//
//	vmq-agent -config /path/config.json     常驻（三平台都以服务方式运行这个）
//	vmq-agent -once                         采一次就退出，适合 cron / 计划任务
//	vmq-agent -check                        只校验配置并打印解析结果
//	vmq-agent -init                         生成示例配置
//	vmq-agent -print                        把一次采集结果打到 stdout（不告警、不上报）
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/alert"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/collect"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/logging"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/report"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/rules"
)

// Version 由构建脚本用 -ldflags 注入。
var Version = "dev"

func main() {
	var (
		cfgPath = flag.String("config", "", "配置文件路径（默认按平台取：Linux /etc/vmq-agent/config.json，macOS /usr/local/etc/…，Windows %ProgramData%\\vmq-agent\\config.json）")
		once    = flag.Bool("once", false, "只采集一次并退出（适合 cron / 计划任务）")
		check   = flag.Bool("check", false, "校验配置并打印解析结果后退出")
		initCfg = flag.Bool("init", false, "生成示例配置文件")
		printJ  = flag.Bool("print", false, "把一次采集结果输出到 stdout（不告警、不上报）")
		wProbe  = flag.Bool("wallet-probe", false, "用当前配置拉一次账单并打印原始返回（校准 items_path / pattern 用）")
		showV   = flag.Bool("version", false, "打印版本")
	)
	flag.Parse()

	if *showV {
		fmt.Printf("vmq-agent %s (%s/%s, report v%s)\n", Version, runtime.GOOS, runtime.GOARCH, protocol.Version)
		return
	}

	path := *cfgPath
	if path == "" {
		path = config.DefaultPath()
	}

	if *initCfg {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fatal("创建配置目录失败: %v", err)
		}
		if _, err := os.Stat(path); err == nil {
			fatal("配置已存在，未覆盖: %s", path)
		}
		if err := os.WriteFile(path, []byte(config.Example()), 0o600); err != nil {
			fatal("写入示例配置失败: %v", err)
		}
		fmt.Printf("已生成示例配置: %s\n请填写 server.base_url 与 server.token 后再启动。\n", path)
		return
	}

	cfg, err := config.Load(path)
	if err != nil {
		fatal("配置错误: %v", err)
	}

	log, err := logging.New(cfg.LogLevel, cfg.Alerts.LogFile)
	if err != nil {
		fatal("初始化日志失败: %v", err)
	}
	defer log.Close()

	if *wProbe {
		runWalletProbe(cfg)
		return
	}

	if *check {
		printCheck(cfg, log)
		return
	}

	collect.AgentVersion = Version
	engine := rules.New(cfg.Rules, time.Duration(cfg.Alerts.CooldownSec)*time.Second)
	dispatcher := alert.New(cfg.Alerts, log)
	reporter := report.New(cfg, log)

	wr, err := newWalletRunner(cfg, log)
	if err != nil {
		fatal("账单监控配置错误: %v", err)
	}

	// 单次模式：给外部调度器（cron / 任务计划）用，行为与常驻模式的一轮完全一致
	if *once || *printJ {
		if *once && wr != nil {
			wr.tick(context.Background())
		}
		rep := cycle(cfg, engine, dispatcher, reporter, wr, log, !*printJ)
		if *printJ {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			_ = enc.Encode(rep)
		}
		return
	}

	log.Infof("vmq-agent %s 启动：agent_id=%s 平台=%s/%s 间隔=%ds 上报=%v 告警通道=%v",
		Version, cfg.AgentID, runtime.GOOS, runtime.GOARCH, cfg.IntervalSec,
		cfg.Report.Enabled, dispatcher.Channels())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if wr != nil {
		go wr.run(ctx)
	}

	ticker := time.NewTicker(time.Duration(cfg.IntervalSec) * time.Second)
	defer ticker.Stop()

	cycle(cfg, engine, dispatcher, reporter, wr, log, true) // 启动后立刻采一次，不等第一个 tick
	for {
		select {
		case <-ctx.Done():
			log.Infof("收到退出信号，停止采集")
			return
		case <-ticker.C:
			cycle(cfg, engine, dispatcher, reporter, wr, log, true)
		}
	}
}

// cycle 是「采集 → 判定 → 告警 → 上报」的一轮，常驻与单次模式共用。
// 任何一步失败都不会中断后续步骤：告警发不出去也要上报，
// 上报不上去也要把结果打在当时可用的日志里。
func cycle(cfg *config.Config, engine *rules.Engine, dispatcher *alert.Dispatcher, reporter *report.Client, wr *walletRunner, log *logging.Logger, doNotify bool) protocol.Report {
	rep := collect.Gather(cfg)
	rep.Wallet = wr.snapshot()

	alerts := engine.Evaluate(rep.Metrics, time.Now())
	rep.Alerts = alerts
	if doNotify && len(alerts) > 0 {
		dispatcher.Dispatch(alerts, rep.Host)
	}

	if cfg.Report.Enabled {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		if err := reporter.Send(ctx, rep); err != nil {
			log.Errorf("上报服务端失败: %v", err)
		}
		cancel()
	}

	log.Infof("采集完成 cpu=%.1f%% mem=%.1f%% disk=%.1f%% 业务=%s 待支付=%d 回调失败=%d 离线=%ds 耗时=%dms",
		rep.Metrics[protocol.MetricCPUPct],
		rep.Metrics[protocol.MetricMemPct],
		rep.Metrics[protocol.MetricDiskPct],
		upText(rep.Business.Up),
		int(rep.Metrics[protocol.MetricPendingOrders]),
		int(rep.Metrics[protocol.MetricNotifyFailed]),
		int(rep.Metrics[protocol.MetricMonitorOfflineSec]),
		rep.System.Extra.CollectMs,
	)
	if len(rep.Errors) > 0 {
		log.Warnf("本轮 %d 项采集异常: %v", len(rep.Errors), rep.Errors)
	}
	return rep
}

func printCheck(cfg *config.Config, log *logging.Logger) {
	fmt.Printf("配置文件      %s\n", cfg.Path)
	fmt.Printf("agent_id      %s\n", cfg.AgentID)
	fmt.Printf("服务端        %s\n", cfg.Server.BaseURL)
	if cfg.Server.Token == "" {
		fmt.Printf("令牌          (空) —— 服务端若要求鉴权，上报会被拒绝\n")
	} else {
		fmt.Printf("令牌          %s\n", mask(cfg.Server.Token))
	}
	fmt.Printf("采集间隔      %ds\n", cfg.IntervalSec)
	fmt.Printf("监控磁盘      %v\n", cfg.Collect.Disks)
	fmt.Printf("监控进程      %v\n", cfg.Collect.Processes)
	fmt.Printf("监控端口      %v\n", cfg.Collect.Ports)
	fmt.Printf("上报          enabled=%v every_n=%d\n", cfg.Report.Enabled, cfg.Report.EveryN)
	fmt.Printf("告警冷却      %ds\n", cfg.Alerts.CooldownSec)
	fmt.Printf("规则          %d 条\n", len(cfg.Rules))
	for _, r := range cfg.Rules {
		fmt.Printf("  - %-22s %s  warn=%g crit=%g for=%ds\n", r.Metric, r.Direction, r.Warn, r.Crit, r.ForSec)
	}
	log.Infof("配置校验通过")
}

func mask(s string) string {
	if len(s) <= 6 {
		return "***"
	}
	return s[:3] + "***" + s[len(s)-3:]
}

func upText(up bool) string {
	if up {
		return "正常"
	}
	return "不可达"
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "vmq-agent: "+format+"\n", args...)
	os.Exit(1)
}
