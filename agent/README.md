# vmq-agent —— 桌面监控端

Windows / macOS / Linux 三平台的 V免签 监控程序：采集主机与支付业务指标 → 判定 → 告警 → 上报。

```
agent/
├── cmd/vmq-agent/        CLI 入口（-once / -check / -init / -print）
├── internal/
│   ├── protocol/         上报契约（与服务端 src/routes/agent.ts 共用同一份结构）
│   ├── config/           配置加载、校验、平台默认路径
│   ├── collect/          采集：三平台原子操作 + 共用汇总
│   ├── rules/            规则引擎：阈值 / 持续时长 / 冷却 / 恢复
│   ├── alert/            webhook（企微/钉钉/飞书/通用）+ 三平台桌面通知 + 日志
│   ├── report/           POST /api/agent/report
│   └── logging/
├── packaging/            systemd / launchd / 计划任务 的安装物
└── scripts/build.sh      六目标交叉编译
```

## 快速开始

```bash
./scripts/build.sh                 # 产出 dist/vmq-agent-<os>-<arch>[.exe]
./dist/vmq-agent-$(go env GOOS)-$(go env GOARCH) -init    # 生成示例配置
./dist/vmq-agent-... -check                               # 校验配置
./dist/vmq-agent-... -once                                # 跑一轮就退出（推荐先这么试）
./dist/vmq-agent-...                                      # 常驻
```

安装成系统服务：

```bash
packaging/linux/install.sh      # sudo，systemd
packaging/darwin/install.sh     # sudo（LaunchDaemon）或 --user（LaunchAgent）
packaging/windows/install.ps1   # 管理员 PowerShell，计划任务
```

## 依赖

- 编译：Go 1.22+（`GO=/path/to/go ./scripts/build.sh` 可指定）
- 运行：**无**。静态单文件二进制，不需要 Go / Node / Python 运行时
- 测试：`go test ./...`

完整说明（指标口径、采集方式、阈值、告警、接入、排障）见
[`docs/monitor-desktop.md`](../docs/monitor-desktop.md)。
