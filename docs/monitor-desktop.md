# 桌面监控端（Windows / macOS / Linux）

一套代码，三个平台：`agent/` 目录下的 Go 程序，同时监控**主机运行状态**与**支付业务状态**，
并把结果统一上报到 V免签 服务端的 `/api/agent/report`。

和手机端 `monitor-android/` 的分工：

| | 手机端（Android） | 桌面端（本程序） |
| --- | --- | --- |
| 位置 | 收款手机上 | 服务器 / 值守机 / 任意一台机器 |
| 主要职责 | 听通知栏到账 → `POST /appPush` 确认订单 | 采集主机 + 业务指标 → 判定 → 告警 + 上报 |
| 解决什么问题 | 「钱到了没人确认」 | 「系统或业务已经不对了，但没人发现」 |

两者互补，互不依赖：不装手机端，桌面端的 `monitor_offline_sec` 会告诉你「没有收款监控端在线」。

---

## 一、三端为什么能保持一致

不是「三份代码写得一样」，而是**一份代码 + 一层薄适配**：

```
agent/
├── cmd/vmq-agent/main.go            唯一的入口：调度、单次模式、自检
├── internal/
│   ├── protocol/protocol.go         ★ 上报契约（三端同一个 JSON 结构）
│   ├── config/config.go             ★ 共用配置结构 + 校验 + 平台默认路径
│   ├── rules/rules.go               ★ 共用规则引擎（阈值 / 持续时长 / 冷却 / 恢复）
│   ├── alert/                       共用调度器 + 三个平台各一个弹窗实现
│   │   ├── alert.go                 webhook / 日志 / 分发
│   │   ├── webhook.go               企微 / 钉钉 / 飞书 / 通用 JSON
│   │   ├── desktop_darwin.go        osascript
│   │   ├── desktop_linux.go         notify-send
│   │   └── desktop_windows.go       PowerShell 气泡
│   ├── collect/                     ★ 共用汇总 + 三平台原子采集
│   │   ├── collect.go               口径统一、指标扁平化、错误兜底
│   │   ├── business.go              探测 /api/health 与 /api/stats
│   │   ├── system_darwin.go         kern.cp_time / vm_stat / netstat / ps
│   │   ├── system_linux.go          /proc/stat / meminfo / net/dev / ps
│   │   └── system_windows.go        GetSystemTimes / GlobalMemoryStatusEx / tasklist
│   ├── report/client.go             POST /api/agent/report（带重试）
│   └── logging/logging.go           面向 journald / launchd / 事件日志的纯文本日志
├── packaging/                       三种运行形态的安装物
│   ├── linux/      systemd unit + install.sh
│   ├── darwin/     launchd plist + install.sh
│   └── windows/    计划任务 + install.ps1
└── scripts/build.sh                 六目标交叉编译
```

**新增一个平台只需要实现 8 个函数**（CPU 采样、内存、磁盘、网络、进程、OS 版本、运行时长、负载），
规则、告警、配置、上报全都不用动 —— 这就是「功能一致」在代码结构上的保证。
另外 `protocol.Report` 是唯一的数据出口，平台差异只能体现为**字段有没有值**，
不可能出现「Windows 报 `cpu`、Linux 报 `cpuUsage`」这类不一致。

依赖：**零第三方库**，全部标准库。二进制是静态单文件（`CGO_ENABLED=0`），
目标机器不需要装 Go、Node、Python 或任何运行时 —— 监控程序必须在「什么都挂了」的时候还能跑。

---

## 二、关键指标、采集方式与默认阈值

### 2.1 系统指标

| 指标 | 上报键 | Linux | macOS | Windows |
| --- | --- | --- | --- | --- |
| CPU 使用率 | `system.cpu.usage_pct` → `cpu_pct` | `/proc/stat` 两次采样求差 | `sysctl kern.cp_time` 求差；**该 oid 不存在时退回 `iostat -c 2 -w 1`** 取 `us+sy` | `GetSystemTimes` 两次求差（kernel 已含 idle） |
| 负载均值 | `load1/5/15` → `load1` | `/proc/loadavg` | `sysctl -n vm.loadavg` | **不适用，字段留空**（不是填 0） |
| 内存 | `mem_pct` | `/proc/meminfo` 的 `MemAvailable` | `hw.memsize` + `vm_stat` 的 free+inactive+speculative | `GlobalMemoryStatusEx` 的 `ullAvailPhys` |
| 交换区 | `swap_pct` | `SwapTotal`/`SwapFree` | `sysctl vm.swapusage` | `TotalPageFile − TotalPhys` |
| 磁盘 | `disk_pct`（取最满挂载点） | `statfs` 的 `Bavail` | 同左 | `GetDiskFreeSpaceExW` |
| 网络累计与速率 | `net.rx_bytes/tx_bytes/rx_rate_bps` | `/proc/net/dev`，跳过 `lo` | `netstat -ibn`，同名网卡取最大值再求和 | `Get-NetAdapterStatistics`（PowerShell） |
| 关注进程 | `proc_missing` | `ps -Ao pid=,comm=` | 同左 | `tasklist /FO CSV /NH` |
| 端口连通 | `port_down` | `net.DialTimeout` 真连一次 | 同左 | 同左 |
| 运行时长 | `host.uptime_sec` | `/proc/uptime` | `sysctl kern.boottime` | `GetTickCount64` |
| OS 版本 | `host.os_version` | `/etc/os-release` + `uname -r` | `sw_vers` + `uname -r` | `cmd /c ver` |
| 主机信息 | `host.*` | hostname / GOOS / GOARCH / Go 版本，三端一致 | | |

几个刻意的取舍：

- **CPU 用「两次采样求差」而不是读瞬时值**：三平台得到的是同一个定义（一段时间内非空闲占比），
  数字之间可比。macOS 上 `kern.cp_time` 在部分版本（实测 13.7 arm64）已被移除，
  所以加了 iostat 兜底 —— 宁可精度差一点，也不能整项指标消失。
- **内存看 available，不看 free**：Linux 的 page cache 和 macOS 的文件缓存都会把 free 压到很低，
  用 free 算使用率会长期虚高，是监控误报的头号来源。
- **进程只报「被点名的」**，不做全量快照：Windows 上全量 `tasklist` 开销明显，
  而排障时真正关心的是「收款客户端还在不在」「服务进程还在不在」。
- **端口用真连一次而不是读监听表**：读表只能看到「有没有在 listen」，
  连一次能顺带发现防火墙拦截、只绑了回环、上游已经挂掉。
- **拿不到就留空，不填 0**：Windows 没有 load average，网络计数器可能因 PowerShell 不可用而失败 ——
  填 0 会被规则误判成「零负载」「零流量」，比缺数据危险得多。

### 2.2 业务指标

业务侧**只读服务端已有的两个公开接口**，不为监控端新开隐私面：

| 来源 | 取到的字段 | 落成指标 |
| --- | --- | --- |
| `GET /api/health` | HTTP 状态 + 往返耗时 | `service_up`(1/0)、`health_latency_ms` |
| `GET /api/stats` | `dbReady` / `dbError` | `db_ready`(1/0) |
| | `monitor.lastHeart`、`monitor.online` | `monitor_offline_sec`（服务端时间戳算差，不受客户端时钟漂移影响） |
| | `passages` | `passages`（可用通道数） |
| | `orders{0,1,2,3}` | `pending_orders` / `paid_orders` / `notify_failed` / `expired_orders` |
| | `totalOrders` | `total_orders` |

`monitor_offline_sec = -1` 是特殊值，表示**还没绑定过任何收款监控端**。
这样全新部署在绑定之前不会一直告警，而一旦心跳过就按真实离线时长计算。

### 2.3 默认阈值（三端完全相同）

| 指标 | 方向 | warn | crit | 持续 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `cpu_pct` | above | 85% | 95% | 120s | 持续高负载 |
| `mem_pct` | above | 90% | 97% | 180s | 可用内存不足 |
| `disk_pct` | above | 85% | 95% | 300s | 磁盘将满 |
| `service_up` | below | 0.5 | 0 | 90s | 支付服务不可达 |
| `db_ready` | below | 0.5 | 0 | 120s | 服务端存储未就绪 |
| `monitor_offline_sec` | above | 120s | 600s | 0s | 收款监控端离线 |
| `notify_failed` | above | 1 | 5 | 60s | 商户回调失败堆积 |
| `pending_orders` | above | 20 | 50 | 300s | 待支付订单堆积 |
| `health_latency_ms` | above | 1500ms | 3000ms | 60s | 服务端响应变慢 |
| `passages` | below | 0.5 | 0 | 300s | 没有可用收款通道 |
| `proc_missing` | above | 1 | 9999 | 180s | 点名的进程没在跑 |
| `port_down` | above | 1 | 9999 | 120s | 点名的端口连不上 |

> `0.5` 这种非整数阈值是有意的：`service_up`/`db_ready` 是 1/0 的布尔值，`passages` 是计数。
> 写 `warn: 1` 会把**正常值 1** 也判成警告，写 `0.5` 才是「低于 1 才告警」。
> 规则引擎还有一层保护：`crit` 必须比 `warn` 更严格才启用，否则退化成只有 `warn` 的单档规则 ——
> 避免配置里漏写 `crit`（默认 0）导致「所有值都算严重」。

---

## 三、三种运行形式

三端都是**常驻进程 + 崩溃自动拉起**，语义一致，只是托管方式跟随各系统的惯例。

### 3.1 Linux —— systemd

```bash
cd agent && VERSION=1.0.0 ./scripts/build.sh
cd packaging/linux && sudo ARCH=amd64 ./install.sh
```

安装脚本做四件事：建 `vmq-agent` 系统用户（采集系统指标不需要 root）、装二进制到
`/usr/local/bin`、生成 `/etc/vmq-agent/config.json`（权限 640，已存在则不覆盖）、
装 unit 并 `enable --now`。

```bash
systemctl status vmq-agent
journalctl -u vmq-agent -f
```

unit 里带 `Restart=always`、`StateDirectory=/var/lib/vmq-agent`、
`LogDirectory=/var/log/vmq-agent`，`ProtectSystem=full` + `PrivateTmp`。

### 3.2 macOS —— launchd

```bash
cd agent && VERSION=1.0.0 ./scripts/build.sh
cd packaging/darwin
sudo ./install.sh          # LaunchDaemon：开机即跑，不需要用户登录（推荐）
./install.sh --user        # LaunchAgent：登录后才跑，能弹桌面通知
```

- **LaunchDaemon**（`/Library/LaunchDaemons/com.vmq.agent.plist`）：与 Linux/Windows 定位一致，
  无人登录也在跑；但没有图形会话，`alerts.desktop` 弹窗**不会出现**（程序会静默降级并记 debug 日志）。
- **LaunchAgent**（`~/Library/LaunchAgents/`）：跟随用户登录，能弹通知中心，适合放在值守机上。

```bash
launchctl print system/com.vmq.agent | head -30
tail -f /usr/local/var/log/vmq-agent.log
```

`KeepAlive=true` + `ThrottleInterval=10`：退出就拉起，但不会疯狂重启刷日志。

### 3.3 Windows —— 计划任务

```powershell
cd agent; $env:VERSION="1.0.0"; .\scripts\build.sh   # 在 WSL/Git Bash 里交叉编译
cd packaging\windows
.\install.ps1                    # 需要管理员
```

```powershell
Get-ScheduledTask -TaskName vmq-agent | Get-ScheduledTaskInfo
Restart-ScheduledTask -TaskName vmq-agent
```

**为什么不是 Windows 服务**：真正的服务要求程序实现 SCM 协议。
要么引入 WinSW/NSSM 这类外部包装（多一个二进制、多一条供应链），
要么为 Windows 单独维护一套服务入口。计划任务在功能上等价 ——
开机即跑、SYSTEM 身份、不需要登录、失败每分钟重启、`-ExecutionTimeLimit 0` 不超时，
而且零外部依赖。要真正的服务语义时，可以把 `vmq-agent.exe` 交给 WinSW 包装，
agent 本身不需要改。

配置生成后脚本会用 `icacls` 把权限收到 `SYSTEM` 与 `Administrators` —— 里面存着令牌。

---

## 四、跨平台共用的配置

一份 JSON，三平台同构；只有**默认路径**不同：

| 平台 | 默认路径 |
| --- | --- |
| Linux | `/etc/vmq-agent/config.json` |
| macOS | `/usr/local/etc/vmq-agent/config.json`（`--user` 模式在 `~/Library/Application Support/vmq-agent/`） |
| Windows | `%ProgramData%\vmq-agent\config.json` |

```bash
vmq-agent -init            # 在默认路径生成示例配置（不覆盖已有文件）
vmq-agent -check           # 校验并打印解析后的配置（令牌打码）
```

```json
{
  "agent_id": "pay-server-01",
  "interval_sec": 30,
  "server": {
    "base_url": "https://pay.example.com",
    "token": "填后台的通讯密钥",
    "timeout_ms": 5000
  },
  "report": { "enabled": true, "every_n": 1 },
  "collect": {
    "disks": ["/"],
    "processes": ["WeChat", "Alipay"],
    "ports": [{ "name": "payment", "host": "127.0.0.1", "port": 443 }],
    "network": true
  },
  "rules": [ { "metric": "cpu_pct", "warn": 85, "crit": 95, "for_sec": 120 } ],
  "alerts": {
    "cooldown_sec": 600,
    "webhook": { "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "template": "wecom" },
    "desktop": { "enabled": true },
    "log_file": ""
  },
  "log_level": "info"
}
```

| 字段 | 说明 |
| --- | --- |
| `agent_id` | 不填则自动派生为 `<主机名>-<平台>`；上报按它覆盖式落库，**同一台机器别配两个 id** |
| `interval_sec` | 采集间隔，最小 5 秒 |
| `server.base_url` | 服务端地址。**默认强制 https**，回环地址放行；内网确需 http 时显式设 `allow_insecure_http: true` |
| `server.token` | 与后台「通讯密钥」一致（也可单独在后台配 `agent_token` 隔离） |
| `report.every_n` | 每 N 轮上报一次，降低服务端写入 |
| `collect.disks` | 要监控的挂载点 / 盘符，`disk_pct` 取其中最满的一个 |
| `collect.processes` | 关注的进程名，**忽略大小写的包含匹配**，同一份配置三平台通用 |
| `collect.ports` | 要探测的 TCP 端口，真连一次 |
| `alerts.*` | 见下节 |

**环境变量覆盖**（适合容器 / systemd `EnvironmentFile` / 不想把令牌写进文件）：

| 变量 | 覆盖 |
| --- | --- |
| `VMQ_AGENT_SERVER` | `server.base_url` |
| `VMQ_AGENT_TOKEN` | `server.token` |
| `VMQ_AGENT_ID` | `agent_id` |
| `VMQ_AGENT_INTERVAL` | `interval_sec` |
| `VMQ_AGENT_LOG_LEVEL` | `log_level` |
| `VMQ_AGENT_WEBHOOK` | `alerts.webhook.url` |

---

## 五、告警机制

### 5.1 判定流程

```
采集 → 扁平化成 metrics → 每条规则独立跑状态机 → 产生 Alert → 分发到各通道 → 随快照上报
```

规则状态机（每条规则一份，内存内）：

```
ok ──越线──> pending（计时）──达到 for_sec──> warn/crit（发告警）
                    │                              │
                    └──回到正常（未达门限，不发）    ├─同级别 + 冷却期内 → 不发
                                                   └─级别升级 warn→crit → 立即发
ok ←──回到正常── 已告警过 → 发一条「已恢复」
```

三个防噪设计：

1. **`for_sec` 持续门限**：瞬时越线不告警。备份、编译、大文件拷贝都会让 CPU/磁盘瞬时冲高，
   没有这层的监控最后一定会被人关掉。
2. **冷却 + 去重**：同一规则同级别在 `cooldown_sec`（默认 600 秒）内只发一次；级别升级立即发。
3. **恢复通知**：只报不恢复，值班的人无法判断故障是否还在。

### 5.2 告警通道

| 通道 | 说明 |
| --- | --- |
| **webhook** | `template` 四选一：`wecom`（企业微信机器人）、`dingtalk`（钉钉）、`feishu`（飞书）、`generic`（自定义消费方拿结构化字段） |
| **desktop** | Windows 气泡 / macOS 通知中心 / Linux `notify-send`。**仅在交互式会话有效**；作为服务/守护进程运行时自动跳过 |
| **日志** | 始终输出到 stderr（被 journald / launchd / 事件日志收走），可选 `log_file` 落盘 |
| **上报服务端** | 告警随快照一起进 `alerts` 字段，由服务端留档，后台可查 |

`generic` 模板的请求体：

```json
{
  "source": "vmq-agent",
  "agent": { "id": "cpu_pct", "host": "pay-server-01", "os": "linux", "arch": "amd64" },
  "alert": { "rule": "disk_pct", "metric": "disk_pct", "level": "warn",
             "value": 87.2, "threshold": 85, "message": "磁盘将满：当前 87.2%，警告阈值 85.0%",
             "ts": 1793796696 },
  "text": "[警告] 磁盘将满：当前 87.2%，警告阈值 85.0%\n主机：pay-server-01（linux）\n时间：2026-11-04 20:51:36"
}
```

> 以服务身份运行时桌面弹窗不可用是**设计上的必然**（session 0 / 无 WindowServer），
> 生产环境请务必配 `alerts.webhook`。桌面弹窗的定位是「人在机器前面时不用翻日志」。

---

## 六、统一接入：三端如何汇总到一处

### 6.1 上报

```
POST {base_url}/api/agent/report
X-Agent-Token: <通讯密钥 或 agent_token>
Content-Type: application/json
```

服务端行为（`src/routes/agent.ts`）：

- 令牌**定长比较**，避免时序侧信道
- 校验 `v` 主版本（当前 `1`）、`agent_id` 必填、`ts` 合法
- `agent_id` 收敛为 `[A-Za-z0-9._-]`（它进 Blob 的 key，必须挡住 `/`）
- 体积上限 256 KB（正常 4–8 KB）
- 落到 `ag/<agent_id>`，**覆盖式保存最新一份**，并附加 `received_at`、`remote_ip`

令牌取值顺序：后台配置 `agent_token` → 通讯密钥（`app_key`）。默认复用通讯密钥是刻意的：
它本来就是这套系统的总密钥，而 agent 上报只写 `ag/` 这一个命名空间，泄漏面没有扩大。
想隔离的部署在后台配 `agent_token` 即可，无需改代码。

**不做历史归档**也是刻意的：30 秒一轮、三台机器，一个月就是几十万条，
Blob 免费额度会先被监控数据吃光，而值班真正要看的只有「现在怎么样」。

### 6.2 查询

```
GET /api/agent/state           # 需要后台会话 cookie；返回所有机器的最新快照
GET /api/agent/state/<id>      # 单机详情
```

返回里带了两个服务端算的字段，方便直接渲染：

- `age_sec`：距上次上报多少秒
- `stale`：是否已失联（`age_sec > interval × 3`）

### 6.3 响应示例

```json
{ "code": 0, "msg": "ok", "agent_id": "pay-server-01" }
```

失败时 `code: -1`，`401` 为令牌错、`413` 为快照过大。

---

## 七、部署与排障

### 7.1 三步上线

```bash
# 1. 编译（任意一台装了 Go 1.22+ 的机器，交叉编译）
cd agent && VERSION=1.0.0 ./scripts/build.sh
#    dist/vmq-agent-{linux,darwin}-{amd64,arm64}
#    dist/vmq-agent-windows-{amd64,arm64}.exe

# 2. 拷到目标机器，装
#    Linux:   packaging/linux/install.sh
#    macOS:   packaging/darwin/install.sh
#    Windows: packaging/windows/install.ps1

# 3. 填配置，重启服务
vmq-agent -check -config /etc/vmq-agent/config.json
systemctl restart vmq-agent
```

`-check` 会打印解析后的完整配置（令牌打码）与规则列表 —— 上线前先跑它，
能挡掉「地址写成 http」「规则指标重复」这类低级错误。

### 7.2 排障

| 现象 | 先看哪里 |
| --- | --- |
| 服务端没有这台机器 | `-check` 看 `base_url` / 令牌；`journalctl -u vmq-agent` 找「上报失败: HTTP 401」 |
| 上报 401 | 令牌不是后台的通讯密钥；或后台单独配了 `agent_token` |
| 上报 400 / 版本错 | 二进制版本与服务端契约不匹配，重新部署对应版本 |
| 指标一片 0 | 看日志里的「本轮 N 项采集异常」：通常是缺 `sysctl`/`ps` 权限，或 Windows 没有 PowerShell |
| 进程监控恒为「在跑」 | 进程名配错了（包含匹配，区分大小写无关）；或 `ps`/`tasklist` 无权限 |
| 收不到桌面弹窗 | 以服务/守护进程运行，没有桌面会话 —— 改用 webhook |
| 磁盘指标缺失 | `collect.disks` 里的路径不存在（Windows 要写 `C:\\`） |

### 7.3 已知限制

1. **Windows 没有 load average**，`load1/5/15` 恒为空，依赖它们的规则会自动跳过。
2. **Windows 网络吞吐依赖 PowerShell**；Server Core 或禁用 PowerShell 时该字段缺失（不是报错）。
3. **macOS 的 `kern.cp_time` 在部分版本已移除**，会自动退回 `iostat`，CPU 数字会有约 1 秒的采样粒度。
4. **桌面弹窗只在交互式会话有效**；服务形态下必然跳过。
5. **不做历史与时序**，只保留最新快照；趋势分析请接外部时序库（上报体是标准 JSON，可以直接转发）。
6. **规则状态在内存里**，进程重启后重新计时。这是有意的取舍：持久化状态容易出现「永远 pending」的僵尸告警。

---

## 八、验证情况

| 项目 | 结果 |
| --- | --- |
| `go test ./...` | 通过（规则状态机 8 组、配置校验 6 组、采集扁平化与进程匹配 3 组） |
| 六目标交叉编译 | `linux/amd64`、`linux/arm64`、`darwin/amd64`、`darwin/arm64`、`windows/amd64`、`windows/arm64` 全部产出，产物 6–7 MB |
| 产物类型 | Linux 为 `ELF 64-bit statically linked`，Windows 为 `PE32+`，均无运行时依赖 |
| 本机实跑（macOS 13.7 arm64） | 采集到 mem 69.9% / disk 15.6% / load 3.25 / net 累计 / 端口连通 / 业务 `up=true health_ms=3` |
| 告警链路 | 规则触发 → 日志 → webhook POST，接收端收到 `generic` 模板，字段完整 |
| 上报链路 | 落库 `ag/e2e-mac`，含 metrics、business、host、received_at；`/api/agent/state` 未登录返回 401 |
| 服务端回归 | `pnpm eo:smoke` 39 项通过（新增 8 项 agent 相关断言） |

本机没有 JDK/Android SDK 之外的限制之外，**Windows 与 Linux 二进制只做了交叉编译验证，未在真机运行**；
首次部署建议先跑 `-once` 单次模式看输出，再切常驻。
