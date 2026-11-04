// Package logging 是一个刻意做得很小的日志器。
//
// 不引第三方日志库的原因：监控程序要以服务身份在三种系统上跑，
// 输出必须能被 journald / launchd / Windows 事件日志直接收走，
// 带颜色和复杂结构的日志反而更难被系统采集。
package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	Debug Level = iota
	Info
	Warn
	Error
)

func ParseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return Debug
	case "warn", "warning":
		return Warn
	case "error":
		return Error
	default:
		return Info
	}
}

type Logger struct {
	mu    sync.Mutex
	level Level
	file  *os.File
}

func New(level string, filePath string) (*Logger, error) {
	l := &Logger{level: ParseLevel(level)}
	if filePath != "" {
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return nil, err
		}
		l.file = f
	}
	return l, nil
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

func (l *Logger) log(lv Level, tag, format string, args ...any) {
	if lv < l.level {
		return
	}
	msg := fmt.Sprintf(format, args...)
	line := fmt.Sprintf("%s %-5s %s\n", time.Now().Format("2006-01-02T15:04:05.000Z07:00"), tag, msg)

	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = os.Stderr.WriteString(line)
	if l.file != nil {
		_, _ = l.file.WriteString(line)
	}
}

func (l *Logger) Debugf(f string, a ...any) { l.log(Debug, "DEBUG", f, a...) }
func (l *Logger) Infof(f string, a ...any)  { l.log(Info, "INFO", f, a...) }
func (l *Logger) Warnf(f string, a ...any)  { l.log(Warn, "WARN", f, a...) }
func (l *Logger) Errorf(f string, a ...any) { l.log(Error, "ERROR", f, a...) }
