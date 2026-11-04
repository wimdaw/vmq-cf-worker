package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateRequiresBaseURL(t *testing.T) {
	c := Default()
	if err := c.Validate(); err == nil {
		t.Fatal("没配 server.base_url 时应当报错")
	}
	c.Server.BaseURL = "https://pay.example.com"
	if err := c.Validate(); err != nil {
		t.Fatalf("配置完整时不该报错: %v", err)
	}
}

func TestValidateRejectsPlainHTTP(t *testing.T) {
	c := Default()
	c.Server.BaseURL = "http://pay.example.com"
	if err := c.Validate(); err == nil {
		t.Fatal("公网地址走 http 应当被拒")
	}
	// 回环地址放行，方便本地联调
	c.Server.BaseURL = "http://127.0.0.1:18790"
	if err := c.Validate(); err != nil {
		t.Fatalf("回环地址应放行: %v", err)
	}
	// 显式允许时也放行（例如内网 HTTPS 成本高的场景）
	c.Server.BaseURL = "http://pay.internal"
	c.Server.AllowInsecureHTTP = true
	if err := c.Validate(); err != nil {
		t.Fatalf("allow_insecure_http=true 时应放行: %v", err)
	}
}

func TestValidateRejectsDuplicateMetric(t *testing.T) {
	c := Default()
	c.Server.BaseURL = "https://pay.example.com"
	c.Rules = []Rule{
		{Metric: "cpu_pct", Warn: 1},
		{Metric: "cpu_pct", Warn: 2},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("同一指标配两条规则应当被拒（状态机会打架）")
	}
}

func TestValidateIntervalFloor(t *testing.T) {
	c := Default()
	c.Server.BaseURL = "https://pay.example.com"
	c.IntervalSec = 1
	if err := c.Validate(); err == nil {
		t.Fatal("间隔小于 5 秒应当被拒，避免把服务端打爆")
	}
}

func TestLoadFillsDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	// 只写最少的字段，其余靠默认值补齐
	if err := os.WriteFile(path, []byte(`{"server":{"base_url":"https://pay.example.com"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("载入失败: %v", err)
	}
	if c.IntervalSec != 30 {
		t.Errorf("interval 默认应为 30，实际 %d", c.IntervalSec)
	}
	if len(c.Rules) == 0 {
		t.Error("默认规则应被填入")
	}
	if c.AgentID == "" {
		t.Error("agent_id 应由主机名自动派生")
	}
	if !strings.HasSuffix(c.AgentID, "-"+runtime.GOOS) {
		t.Errorf("agent_id 应带平台后缀，实际 %s", c.AgentID)
	}
	if c.DataDir != dir {
		t.Errorf("data_dir 默认应跟随配置目录，实际 %s", c.DataDir)
	}
}

func TestEnvOverride(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"server":{"base_url":"https://a.example.com","token":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VMQ_AGENT_TOKEN", "from-env")
	t.Setenv("VMQ_AGENT_INTERVAL", "45")

	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.Token != "from-env" {
		t.Errorf("环境变量应覆盖文件里的令牌，实际 %s", c.Server.Token)
	}
	if c.IntervalSec != 45 {
		t.Errorf("环境变量应覆盖采集间隔，实际 %d", c.IntervalSec)
	}
}

func TestDefaultRulesAreSane(t *testing.T) {
	// 防止改默认值时把 above/below 的方向或 crit 与 warn 的大小关系写反
	for _, r := range DefaultRules() {
		if r.Direction == "below" {
			if r.Crit >= r.Warn {
				t.Errorf("%s: direction=below 时 crit(%g) 必须小于 warn(%g)", r.Metric, r.Crit, r.Warn)
			}
			continue
		}
		if r.Crit <= r.Warn {
			t.Errorf("%s: direction=above 时 crit(%g) 必须大于 warn(%g)", r.Metric, r.Crit, r.Warn)
		}
	}
}
