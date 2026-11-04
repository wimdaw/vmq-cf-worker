package wallet

import (
	"testing"
	"time"
)

// 金额提取是整套系统最容易出错的地方：文案里常带余额，
// 取错一个数字就是错账，所以用真实到账文案锁住行为。
func TestExtractMoney(t *testing.T) {
	cases := []struct{ text, want string }{
		{"微信支付收款 18.01 元", "18.01"},
		{"收款 18.01 元，余额 1234.56 元", "18.01"}, // 必须取第一个，不是余额
		{"【微信收款助手】微信支付收款0.01元", "0.01"},
		{"你已成功收款 100.00 元", "100.00"},
		{"到账金额：5.20", "5.20"},
		{"收款 0.001 元", ""},     // 三位小数不算金额
		{"收款 999999.00 元", ""}, // 超出上限，避免把订单号当金额
		{"本条消息没有金额", ""},
	}
	for _, c := range cases {
		if got := ExtractMoney(c.text); got != c.want {
			t.Errorf("ExtractMoney(%q) = %q，期望 %q", c.text, got, c.want)
		}
	}
}

// 签名必须与 monitor-android 的 Signer 完全一致，否则服务端一律回「签名校验不通过」。
func TestSignMatchesAndroid(t *testing.T) {
	// md5("2" + "18.01" + "1793797523" + "9" + "e2e-key")
	got := Sign(TypeAlipay, "18.01", "1793797523", "9", "e2e-key")
	if len(got) != 32 {
		t.Fatalf("md5 长度应为 32，实际 %d", len(got))
	}
	// 与 e2e 实测中服务端真正接受的签名一致（同一组输入，独立用 python md5 复算过）
	if got != "d9d2a8df481aa53628bd48253b62ba94" {
		t.Fatalf("签名口径变了：%s（服务端会判校验不通过）", got)
	}
}

func TestDeduperWindow(t *testing.T) {
	d := NewDeduper(time.Minute)
	if d.SeenBefore("a") {
		t.Fatal("首次不该判重")
	}
	if !d.SeenBefore("a") {
		t.Fatal("第二次应判重")
	}
	// A → B → A：交错场景下第二个 A 仍然要能判出来
	d.SeenBefore("b")
	if !d.SeenBefore("a") {
		t.Fatal("交错场景漏判")
	}
}

func TestParseJSONBill(t *testing.T) {
	b, err := NewAlipayBill(AlipayBillCfg{
		Endpoint:   "http://example.com/bill",
		ItemsPath:  "data.list",
		FieldMoney: "amount",
		FieldTime:  "time",
		FieldTitle: "subject",
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"data":{"list":[
		{"subject":"收钱码收款","amount":"18.01","time":"2026-11-04 20:00:00"},
		{"subject":"不是钱","amount":"","time":"2026-11-04 20:00:00"}
	]}}`)
	recs, err := b.parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 {
		t.Fatalf("应解析出 2 条，实际 %d", len(recs))
	}
	if recs[0].Money != "18.01" || recs[0].Title != "收钱码收款" {
		t.Errorf("字段映射错误: %+v", recs[0])
	}
	if recs[0].TS == 0 {
		t.Error("时间没解析出来")
	}
}

func TestCollectMapsEmptyPath(t *testing.T) {
	// items_path 留空时，根就是数组
	items := collectMaps([]any{map[string]any{"a": 1}}, "")
	if len(items) != 1 {
		t.Fatalf("根数组应被识别，实际 %d", len(items))
	}
	if got := collectMaps(map[string]any{"x": 1}, "missing.path"); len(got) != 0 {
		t.Fatalf("路径不存在应返回空，实际 %d", len(got))
	}
}
