# 部署到 EdgeOne（Makers / Pages）

这是 V免签的 **EdgeOne 版**：同一套业务代码，数据层从 Cloudflare D1 换成 EdgeOne Blob。
Cloudflare 的部署方式（`wrangler`）在这个分支上不再适用，但代码仍保留，方便对照。

## 一、为什么不是「换个配置文件」的事

| Cloudflare | EdgeOne | 本分支怎么处理 |
| --- | --- | --- |
| Worker `fetch(req, env, ctx)` | Cloud Functions `onRequest(context)` | `src/edgeone-entry.ts` 适配，垫出 `env` 与 `waitUntil` |
| D1（SQLite） | **没有托管数据库** | 数据层改成 Blob 上的 JSON 文档，见 `src/lib/blob-db.ts` |
| `assets` 绑定 + `env.ASSETS.fetch` | 静态文件由平台直接分发，**优先于函数** | 7 个 HTML 外壳不进静态目录，构建期内嵌进函数 |
| `triggers.crons` 每分钟 | `edgeone.json` 的 `schedules` | 定时打 `/api/cron/tick`，另加「请求内惰性 cron」兜底 |
| `ctx.waitUntil` | Node 运行时没有 | 入口里做垫片 |

**为什么不用 KV**：EdgeOne KV 只有 Edge Functions 能用（V8，每天 200ms CPU、无 npm），
而且是 **60 秒最终一致**，没有强一致模式。这个系统有两处必须「写后立刻读到」：
金额池占位（同一金额只能有一笔待支付订单）和支付状态回读，KV 会直接串单。

Blob 有两个能力刚好对上：

- `get(key, { consistency: 'strong' })` —— 绕过 CDN 直读主存储，写后立刻读得到
- `set(key, value, { onlyIfNew: true })` —— 条件写，等价于 `INSERT OR IGNORE` 的主键冲突

## 二、数据是怎么存的

「表」= key 前缀，全部走强一致读写：

```
cfg                      全站配置 {k: v}
mon                      监控端心跳 {last_heart, last_pay}
o/<order_id>             订单全文
ou/<out_trade_no>        → order_id      （条件写，商户订单号唯一）
oi/<id>                  → order_id      （后台按 id 操作）
pool/<分>-<类型>          → order_id      （条件写，金额池互斥）
poolby/<order_id>        → pool key      （释放用）
odx/<YYYY-MM>            当月订单摘要数组（列表 / 统计的唯一数据源）
nt/<id>                  回调任务
ntq/<next_at>-<id>       回调到期索引（key 有序，扫前缀即可）
ps                       通道数组
ad                       管理员数组
lg/<uid>/<时间>-<id>      操作日志
up/<hash>               上传图片二进制
um/<时间>-<id>           未匹配到账推送
lk/<name>                租约锁
```

两点设计取舍：

1. **统计不做增量计数**，看板、通道收款笔数、累计收入全部从 `odx/*` 现算（进程内缓存 5 秒）。
   增量计数漏写一次就会长期偏差，而且删单、补单、回调重试都得同步维护。
2. **只有「必须原子」的两处用条件写**（金额池、商户订单号），其余读改写用租约锁串行，
   锁粒度是「当月摘要」，不是全表。

原来的 `schema.sql` 在 EdgeOne 版**不需要执行** —— 没有建表这回事，第一次写入自动产生 key。

## 三、部署步骤

### 0. 前置

- Node.js 20+
- pnpm 9+（`corepack enable`）
- EdgeOne 账号（Makers / Pages，免费版够用）

### 1. 装依赖 + 构建

```bash
pnpm install
pnpm eo:build        # 构建前台/后台 SPA → dist/，并打包函数 → cloud-functions/
```

产物：

```
dist/                          静态站（/static、/site/assets、/console/assets、favicon）
cloud-functions/[[default]].js 函数包（约 90 KB，含 Blob SDK）
cloud-functions/index.js       根路径 / 的入口
```

### 2. 本地先跑一遍

```bash
pnpm eo:dev          # http://localhost:8787，数据走内存实现，重启清空
```

打开 `/setup` 建管理员。

### 3. 生成路由表（**必做，漏了全站 404**）

```bash
npx edgeone makers generate-routes
```

`eo:build` 只产出代码，**不产路由**。不跑这一步，部署后 `.edgeone/routes.json`
里只有两条没有 `server-name` 的兜底规则，平台不知道哪些请求该进函数，
表现为**首页、接口、后台全部 404**（静态资源却是 200，很容易误判成代码问题）。
正确生成后应是这个顺序：

```json
[
  { "src": "^/(.*)$", "handle": "filesystem" },                    // 先找静态文件
  { "src": "^/$",     "dest": "cloud-functions/api-node" },        // 再进函数
  { "src": "^/(.*)$", "dest": "cloud-functions/api-node" }
]
```

所以 `eo:build` → `generate-routes` → `deploy` 三步不能省。
`package.json` 里已串好：`pnpm eo:deploy` 依次跑这三步，单独重生成路由用 `pnpm eo:routes`。

### 4. 部署

```bash
npx edgeone login                 # 或跳过，直接给命令带 token
npx edgeone makers deploy \
  -n vmq \
  -t "$EDGEONE_TOKEN" \
  -a overseas \
  --json \
  --skip-ai-gateway-sync
```

- `-n` 是项目名，首次部署会新建，之后同名即更新
- `-a overseas` 指定海外站（大陆站需要备案域名）
- `--skip-ai-gateway-sync` 跳过 AI 网关同步，个人项目用不到，能省一截部署时间
- 部署会清理 `.edgeone/`；如果上一次部署中断留下残留，报
  `safe-delete broker denied delete`，先 `rm -rf .edgeone` 再重跑

部署后第一件事：访问 `https://<你的域名>/setup` 完成初始化（创建管理员、随机生成通讯密钥）。
**初始化完成后 `/setup` 永久 404**，这是设计行为。

### 5. 环境变量（可选但建议）

在 EdgeOne 控制台的项目设置里加：

| 变量 | 作用 |
| --- | --- |
| `ADMIN_ALIAS` | 后台入口别名。配了就不查库，也防止别人猜到 `/admin` |
| `SETUP_TOKEN` | 首次初始化的口令，`/setup?token=xxx` 才能打开，防止被人抢先初始化 |
| `CRON_TOKEN` | 定时任务口令，`/api/cron/tick?token=xxx` 才会执行 |
| `RESOURCE_URL` | 静态资源兜底基址（默认相对路径，指向平台自己） |

### 6. 定时任务

`edgeone.json` 里默认有一条：

```json
"schedules": [
  { "name": "vmq-tick", "cron": "0 3 * * *", "path": "/api/cron/tick?token=change-me", "timezone": "Asia/Shanghai" }
]
```

**把 `change-me` 换成你的 `CRON_TOKEN`**，否则这个任务会一直 401（不影响业务，见下）。

⚠️ **免费版 cron 的最小间隔是「一天」，不是一分钟。** 官方文档两种说法并存，实测以这条报错为准：

```
❌ Schedule task "vmq-tick" cron "* * * * *" triggers more frequently than once per day.
   The minimum interval for the free plan is 1 day (86400s).
```

所以默认写成每天 3 点，一天兜一次底。

`/api/cron/tick` 干三件事：关超时订单、重试失败回调、清理孤儿金额占位。
真正的分钟级靠的是**请求内惰性 cron**：任何请求进来时，如果这个实例超过 60 秒没跑过，
就顺手跑一次（`lazyCron`，成本只有一次 `cfg` 读）。所以

- **站点有流量时**：关单、回调重试的实际精度是「分钟级」，跟 Cloudflare 版没差别
- **完全没流量时**：没人下单也就没有待关订单，每天那次兜底足够

这条设计也让部署不依赖平台 cron 的档位，换付费版调高频率只是锦上添花。

## 四、限制与注意事项

**必须知道的**

1. **单值 25 MB、账号总容量 1 GB（免费版）**。订单摘要按月存，1 万单大约 2~3 MB，
   个人收款量级够用；真到天花板时按年归档即可。
2. **没有事务**。跨 key 的一次操作（订单 + 摘要 + 金额池）不是原子的，
   所有写路径都按「幂等 + 状态条件校验」写（`patchOrder(orderId, patch, expectStatus)`），
   重复执行不会算两次钱。
3. **预置域名 `*.edgeone.dev` 在大陆访问会 401**，正式使用请绑定自己的域名（已备案）。
4. **每请求会增加 2~5 次 Blob 往返**（强一致读走主存储），比 Workers 同进程读 D1 慢。
   实测跨境节点下单在 300~600 ms 量级，个人收款可接受。
5. **图片上传**从「base64 塞数据库、1.4MB 上限」变成 Blob 二进制（`up/<hash>`），
   实际可放到 25 MB，前端提示仍是 1.4 MB。

**和 Cloudflare 版的差异**

- `schema.sql` / `seed.sql` / `db:*` 脚本不再使用（保留仅作历史对照）
- `pnpm dev` / `pnpm deploy`（wrangler）在这个分支上不可用，用 `pnpm eo:*`
- 统计口径不变（`status in (1,2)` 都算钱已到账，按 Asia/Shanghai 分天）
- 后台、前台、监控端协议、易支付签名全部未改动，监控端 App 无需修改

## 五、验收清单

### 本地

```bash
pnpm test        # 单元回归（类型检查 + 域名/别名/签名/二维码/参数等）
pnpm eo:build && pnpm eo:smoke   # 端到端 31 项断言，跑在内存库上
```

或用一条串好的门禁：`pnpm verify`（= test + eo:build + eo:smoke + check:leak）。

两点说明：

- `test:qr` 里的「解码回读」需要 `pip3 install --user numpy zxing-cpp segno`，
  没装会报 `ModuleNotFoundError`，与业务代码无关。
- **`test:http` / `test:api` 这两个脚本是 Cloudflare 版专用的**（它们直接读
  `.wrangler/state/v3/d1` 里的 SQLite 拿配置），在本分支不可用；
  `pnpm verify:cf` 保留了原链路，仅供对照。EdgeOne 版对应的回归是 `eo:smoke`。

`eo:smoke` 覆盖：初始化建管理员、登录鉴权、通道增删、下单与金额池占位、
重复金额不串单、监控端心跳、查询接口、支付回调入库、重复回调幂等、
未匹配金额记录、看板统计、定时关单与金额池释放、后台鉴权、静态资源与前后台外壳。

### 线上（真实部署后逐条验证过）

| 项 | 结果 |
| --- | --- |
| `/setup` 初始化 | 302 跳转，**再次访问 404**（说明写入持久化了） |
| 后台登录（含 SVG 验证码） | 通过 |
| 建通道 / 监控端 `appHeart` | 通过 |
| `/demo.html?type=wxpay&money=1.00` | 302 到 `/pay/<order_id>` |
| 查单 | `status:0, truemoney:"1.00"` |
| `appPush` 回调入库 | 通过 |
| 再查单 | `status:1` + `payTime` 写入 |
| **同一订单连查 6 次** | `1 1 1 1 1 1` —— 跨实例强一致读成立 |
| 订单列表 / 看板 | `count:1`，金额、笔数一致 |
| **重复推送同一笔** | 「无匹配订单，已记录」—— 金额池已释放，不重复记账 |
| 静态资源 | favicon / site-js / console / doc 全部 200 |

「连查 6 次」和「重复推送」这两条是关键：前者验证 Blob 强一致读真的绕过了 CDN，
后者验证没有事务时靠「金额池释放 + 状态条件校验」也能做到幂等。

## 六、本地开发小抄

```bash
pnpm eo:build && pnpm eo:dev     # 构建 + 起本地服务（内存库）
curl localhost:8787/api/health
```

本地服务复刻了平台的两条行为用于自测：静态文件优先、其余进函数；
`scripts/eo-local.mjs` 里可以直接看到路由顺序。
