package main

import "testing"

// 到账链路自身的健康度：停滞时长与连续失败次数。
// 这两条决定「轮询挂了能不能被发现」，比「有没有到账」更不该误报。
func TestWalletMetrics(t *testing.T) {
	var nilRunner *walletRunner
	if nilRunner.metrics(100) != nil {
		t.Error("未启用时应返回 nil，让指标整体缺省、规则自动跳过")
	}

	r := &walletRunner{}
	r.st.LastOKTS = 1000
	r.st.LastPollTS = 1010
	r.st.ErrStreak = 2

	m := r.metrics(1300)
	if m["wallet_poll_age_sec"] != 300 {
		t.Errorf("停滞时长应为 300，实际 %v", m["wallet_poll_age_sec"])
	}
	if m["wallet_error_streak"] != 2 {
		t.Errorf("失败次数应为 2，实际 %v", m["wallet_error_streak"])
	}

	// 还没成功过时用首次轮询时间兜底，避免一启动就误报「停滞」
	r2 := &walletRunner{}
	r2.st.LastPollTS = 500
	if got := r2.metrics(560)["wallet_poll_age_sec"]; got != 60 {
		t.Errorf("应以首次轮询为基准算 60，实际 %v", got)
	}
}
