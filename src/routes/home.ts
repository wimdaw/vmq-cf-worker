import type { Env } from '../lib/db';
import { getConfig } from '../lib/db';
import { html, json, now } from '../lib/util';
import { allConfig, countsByStatus, getMonitor, listOrders, listPassages } from '../lib/blob-db';

interface Stats {
  dbReady: boolean;
  dbError: string;
  ts: number;
  monitor: { lastHeart: number; lastPay: number; online: boolean };
  passages: number;
  orders: Record<string, number>;
  totalOrders: number;
  recent: Array<{
    order_id: string;
    money: string;
    truemoney: string;
    status: number;
    create_time: number;
  }>;
}

const STATUS_LABEL: Record<number, string> = {
  0: '待支付',
  1: '已支付',
  2: '回调失败',
  3: '已过期',
};

const ROUTES: Array<[string, string]> = [
  ['/appPush', '监控端推送到账（GET/POST）'],
  ['/appHeart', '监控端心跳'],
  ['/api/order/create', '商户下单入口（兼容 /submit.php）'],
  ['/pay/:orderId', '支付页'],
  ['/api/order/status?orderId=', '支付页轮询'],
  ['/api/stats', '本页数据的 JSON 版本'],
  ['/api/health', '健康检查'],
];

export async function collectStats(env: Env): Promise<Stats> {
  const ts = now();
  const base: Stats = {
    dbReady: false,
    dbError: '',
    ts,
    monitor: { lastHeart: 0, lastPay: 0, online: false },
    passages: 0,
    orders: {},
    totalOrders: 0,
    recent: [],
  };

  try {
    await allConfig();
    base.dbReady = true;
  } catch (e) {
    base.dbError = String(e).slice(0, 300);
    return base;
  }

  const ms = await getMonitor();
  base.monitor = {
    lastHeart: ms.last_heart,
    lastPay: ms.last_pay,
    online: ts - ms.last_heart <= 60,
  };

  base.passages = (await listPassages({ status: 1, limit: 1, offset: 0 })).count;

  const counts = await countsByStatus();
  for (const [k, v] of Object.entries(counts)) {
    base.orders[k] = v;
    base.totalOrders += v;
  }

  const debug = (await getConfig(env, 'DEBUG_PAGE', '0')) === '1';
  if (debug) {
    const recent = await listOrders({ limit: 8, offset: 0 });
    base.recent = recent.rows.map((r) => ({
      order_id: r.order_id,
      money: r.money,
      truemoney: r.truemoney,
      status: r.status,
      create_time: r.create_time,
    }));
  }

  return base;
}

function ago(ts: number, nowTs: number): string {
  if (!ts) return '从未';
  const s = nowTs - ts;
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function fmtTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date((ts + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const CSS = `
:root{--bg:#f7f8fa;--card:#fff;--line:#e6e8eb;--fg:#1f2329;--mute:#8a919e;--ok:#12a150;--bad:#e5484d;--warn:#e8a33d;--blue:#1668dc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:32px 20px 56px}
h1{font-size:19px;margin:0 0 4px}
.sub{color:var(--mute);font-size:13px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 14px;color:var(--mute);font-weight:500;letter-spacing:.02em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
.kv{display:flex;flex-direction:column;gap:2px}
.kv .k{color:var(--mute);font-size:12px}
.kv .v{font-size:17px;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px;line-height:19px}
.tag.ok{background:#e7f6ed;color:var(--ok)}
.tag.bad{background:#fdecec;color:var(--bad)}
.tag.warn{background:#fdf3e3;color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mute);font-weight:500;font-size:12px}
td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
code{background:#f2f3f5;padding:1px 6px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:#1f2329;color:#e6e8eb;padding:14px 16px;border-radius:8px;overflow:auto;font-size:12.5px}
.hint{color:var(--mute);font-size:12.5px;margin-top:10px}
a{color:var(--blue);text-decoration:none}
ul{margin:0;padding-left:18px}
li{margin:3px 0}
`;

export async function handleHome(env: Env): Promise<Response> {
  const s = await collectStats(env);

  if (!s.dbReady) {
    return html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vmq · 需要初始化数据库</title><style>${CSS}</style></head><body><div class="wrap">
<h1>数据库还没初始化</h1>
<div class="sub">服务已启动，但本地 D1 里没有任何表。</div>
<div class="card">
<h2>执行这一条命令</h2>
<pre>pnpm db:local</pre>
<div class="hint">它会用 <code>schema.sql</code> 建 9 张表。执行完刷新本页即可。</div>
</div>
<div class="card">
<h2>原始错误</h2>
<pre>${esc(s.dbError)}</pre>
</div>
</div></body></html>`, 200);
  }

  const o = s.orders;
  const pending = o['0'] ?? 0;
  const paid = o['1'] ?? 0;
  const failed = o['2'] ?? 0;
  const expired = o['3'] ?? 0;

  const monitorTag = s.monitor.online
    ? `<span class="tag ok">在线</span>`
    : `<span class="tag bad">离线</span>`;

  const recentBlock =
    s.recent.length > 0
      ? `<div class="card"><h2>最近订单（DEBUG_PAGE=1）</h2>
<table><thead><tr><th>平台订单号</th><th>金额</th><th>实付</th><th>状态</th><th>创建时间</th></tr></thead><tbody>
${s.recent
  .map(
    (r) => `<tr><td class="mono">${esc(r.order_id)}</td><td>￥${esc(r.money)}</td>
<td>￥${esc(r.truemoney)}</td><td>${STATUS_LABEL[r.status] ?? r.status}</td>
<td class="mono">${fmtTime(r.create_time)}</td></tr>`
  )
  .join('')}
</tbody></table></div>`
      : `<div class="card"><h2>最近订单</h2><div class="hint">暂无订单。在 <code>config</code> 表里把 <code>DEBUG_PAGE</code> 设为 <code>1</code> 可显示最近 8 笔。</div></div>`;

  return html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vmq · 服务状态</title><style>${CSS}</style></head><body><div class="wrap">
<h1>vmq 服务状态</h1>
<div class="sub">${fmtTime(s.ts)}（UTC+8） · 数据库已就绪</div>

<div class="card">
<h2>运行状态</h2>
<div class="grid">
  <div class="kv"><span class="k">监控端</span><span class="v">${monitorTag}</span></div>
  <div class="kv"><span class="k">最近心跳</span><span class="v">${ago(s.monitor.lastHeart, s.ts)}</span></div>
  <div class="kv"><span class="k">最近收款</span><span class="v">${ago(s.monitor.lastPay, s.ts)}</span></div>
  <div class="kv"><span class="k">可用通道</span><span class="v">${s.passages}</span></div>
</div>
${s.passages === 0 ? `<div class="hint">⚠️ 还没有可用通道，下单会直接失败。需要往 <code>passages</code> 表插入至少一条记录。</div>` : ''}
</div>

<div class="card">
<h2>订单统计</h2>
<div class="grid">
  <div class="kv"><span class="k">待支付</span><span class="v">${pending}</span></div>
  <div class="kv"><span class="k">已支付</span><span class="v">${paid}</span></div>
  <div class="kv"><span class="k">回调失败</span><span class="v">${failed}</span></div>
  <div class="kv"><span class="k">已过期</span><span class="v">${expired}</span></div>
  <div class="kv"><span class="k">合计</span><span class="v">${s.totalOrders}</span></div>
</div>
</div>

${recentBlock}

<div class="card">
<h2>可用路由</h2>
<table><tbody>
${ROUTES.map(([p, d]) => `<tr><td class="mono">${esc(p)}</td><td>${esc(d)}</td></tr>`).join('')}
</tbody></table>
</div>

<div class="card">
<h2>下一步</h2>
<ul>
  <li>填 <code>config</code> 表的 <code>key</code>（通讯密钥）和 <code>merchant_key</code>（商户密钥）——必须和旧系统一致</li>
  <li>往 <code>passages</code> 插一条通道（<code>type</code>/<code>ewm</code>）</li>
  <li>把 <code>require_online</code> 设 <code>0</code> 可先跳过"监控端必须在线"的检查</li>
  <li>下单测试：需要按易支付规则签名后访问 <code>/api/order/create</code>（旧地址 <code>/submit.php</code> 仍可用）</li>
</ul>
</div>

</div></body></html>`, 200);
}

export async function handleStats(env: Env): Promise<Response> {
  const s = await collectStats(env);
  return json(s);
}
