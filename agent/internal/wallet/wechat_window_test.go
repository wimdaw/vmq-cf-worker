package wallet

import (
	"testing"
	"time"
)

// 窗口源最容易出的两个错：一启动就把历史消息全推一遍、同一条消息重复推。
// 这两个行为都在 extract 里，可以脱离 GUI 直接测。
func TestWeChatWindowPrimingAndDedup(t *testing.T) {
	w := &WeChatWindow{
		cfg:     WeChatCfg{},
		dedup:   NewDeduper(time.Hour),
		timeout: time.Second,
	}

	history := "微信收款助手\n收款 18.01 元\n昨天收款 5.00 元\n随便聊聊"

	// 首轮：只建立基线，一条都不报
	if got := w.extract(history); len(got) != 0 {
		t.Fatalf("首轮不该产生事件，实际 %d 条", len(got))
	}
	w.primed = true

	// 同一屏内容再读一次：全是已见过的，不该重复报
	if got := w.extract(history); len(got) != 0 {
		t.Fatalf("历史消息不该重复上报，实际 %d 条", len(got))
	}

	// 来了一笔新的
	fresh := history + "\n收款 20.00 元"
	got := w.extract(fresh)
	if len(got) != 1 {
		t.Fatalf("应识别 1 条新到账，实际 %d 条", len(got))
	}
	if got[0].Money != "20.00" {
		t.Errorf("金额错误: %s", got[0].Money)
	}
	if got[0].Type != TypeWeChat {
		t.Errorf("type 应为微信(1)，实际 %d", got[0].Type)
	}

	// 再读一次同样的内容，仍然不重复
	if again := w.extract(fresh); len(again) != 0 {
		t.Fatalf("同一条到账被重复上报 %d 次", len(again))
	}
}

// 没有关键词的金额不算到账（例如聊天里提到"我转了 20.00"）
func TestWeChatWindowRequiresKeyword(t *testing.T) {
	w := &WeChatWindow{cfg: WeChatCfg{}, dedup: NewDeduper(time.Hour)}
	w.primed = true
	if got := w.extract("我转了 20.00 给你"); len(got) != 0 {
		t.Fatalf("无关键词不该上报，实际 %d 条", len(got))
	}
}
