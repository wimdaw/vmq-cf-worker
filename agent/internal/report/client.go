// Package report 把一次采集结果推给服务端的统一接入点。
//
// 三平台推的是同一个 /api/agent/report、同一个 JSON 结构，
// 服务端只按 agent_id 落一份最新快照，因此「多端统一接入」在传输层就已经成立。
package report

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/wimdaw/vmq-cf-worker/agent/internal/config"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/logging"
	"github.com/wimdaw/vmq-cf-worker/agent/internal/protocol"
)

type Client struct {
	url   string
	token string
	hc    *http.Client
	log   *logging.Logger
}

func New(cfg *config.Config, log *logging.Logger) *Client {
	return &Client{
		url:   cfg.Server.BaseURL + "/api/agent/report",
		token: cfg.Server.Token,
		hc:    &http.Client{Timeout: cfg.Timeout()},
		log:   log,
	}
}

type respBody struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

// Send 带重试地推一次快照。
//
// 重试只针对网络错误与 5xx：4xx 是配置问题（令牌错、字段不合法），
// 重试一万次也不会好，只会把日志刷满。
func (c *Client) Send(ctx context.Context, rep protocol.Report) error {
	body, err := json.Marshal(rep)
	if err != nil {
		return fmt.Errorf("序列化上报体失败: %w", err)
	}

	const attempts = 3
	var lastErr error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(i*i) * time.Second):
			}
		}

		retriable, err := c.once(ctx, body)
		if err == nil {
			return nil
		}
		lastErr = err
		if !retriable {
			return err
		}
		c.log.Warnf("上报失败（第 %d/%d 次，将重试）: %v", i+1, attempts, err)
	}
	return lastErr
}

func (c *Client) once(ctx context.Context, body []byte) (retriable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-Agent-Token", c.token)
	req.Header.Set("User-Agent", "vmq-agent/"+protocol.Version)

	resp, err := c.hc.Do(req)
	if err != nil {
		return true, err // 网络层问题，值得重试
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	if resp.StatusCode >= 500 {
		return true, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(raw), 160))
	}
	if resp.StatusCode >= 400 {
		return false, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(raw), 160))
	}

	var rb respBody
	if err := json.Unmarshal(raw, &rb); err == nil && rb.Code != 0 {
		return false, fmt.Errorf("服务端拒绝: %s", rb.Msg)
	}
	return false, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
