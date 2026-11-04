/**
 * EdgeOne 版端到端冒烟（不依赖任何外部服务）。
 *
 * 跑法：pnpm eo:smoke（内部会用 esbuild 把本文件打成单文件再执行，
 * 数据走 blob-store 的内存实现，所以整个链路在一个进程里闭合）。
 *
 * 覆盖：初始化 → 下单 → 支付页 → 心跳 → 到账推送 → 查单 → 商户回调 →
 *      统计 → cron 关单 → 金额池释放 → 后台接口鉴权。
 */
import { createServer } from 'node:http';
import { onRequest } from '../src/edgeone-entry';
import * as db from '../src/lib/blob-db';
import { epaySign, monitorSign } from '../src/lib/sign';
import { now } from '../src/lib/util';

const BASE = 'http://vmq.local';
const KEY = 'test-only-comm-key';
const PORT = 18788;

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

type Ctx = { request: Request; env?: Record<string, string> };

function call(path: string, init: RequestInit = {}, env: Record<string, string> = {}): Promise<Response> {
  const ctx: Ctx = { request: new Request(BASE + path, init), env };
  return (onRequest as (c: Ctx) => Promise<Response>)(ctx);
}

const form = (o: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

async function main(): Promise<void> {
  /* 商户回调接收端：验证「支付成功 → 回调商户」这条链路真的发出去了 */
  const callbacks: string[] = [];
  const receiver = createServer((req, res) => {
    callbacks.push(req.url ?? '');
    res.end('success');
  });
  await new Promise<void>((r) => receiver.listen(PORT, r));

  console.log('\n[1] 首次初始化 /setup');
  const fd = new FormData();
  fd.set('username', 'admin');
  fd.set('password', 'test-only-password');
  fd.set('password2', 'test-only-password');
  fd.set('alias', 'consolex');
  fd.set('sitename', '测试站点');
  const setup = await call('/setup', { method: 'POST', body: fd });
  check('初始化返回 302', setup.status === 302, String(setup.status));
  check('管理员已创建', (await db.countAdmins()) === 1);
  const setupAgain = await call('/setup');
  check('初始化后 /setup 变 404', setupAgain.status === 404, String(setupAgain.status));

  console.log('\n[2] 准备站点数据');
  await db.saveConfig([
    ['key', KEY],
    ['require_online', '1'],
    ['payQf', '1'],
    ['close', '5'],
    ['title', '测试站点'],
    ['notify_success_body', 'success'],
  ]);
  await db.insertPassage({ type: 1, ewm: 'wxp://test-only-paycode', status: 1 });
  await db.setMonitor({ last_heart: now() });
  check('通道已就绪', (await db.listPassages({ status: 1, limit: 9, offset: 0 })).count === 1);

  console.log('\n[3] 前台页面');
  const home = await call('/');
  const homeHtml = await home.text();
  check('首页 200', home.status === 200, String(home.status));
  check('首页注入站点名', homeHtml.includes('测试站点'));
  check('首页注入静态资源基址', homeHtml.includes('__VMQ_ASSET_BASE__'));
  const doc = await call('/doc.html');
  check('文档页 200', doc.status === 200, String(doc.status));
  const spa = await call('/consolex');
  const spaHtml = await spa.text();
  check('后台外壳 200', spa.status === 200 && spaHtml.includes('<div id="root">'), String(spa.status));

  console.log('\n[4] 商户下单');
  const outTradeNo = `T${Date.now()}`;
  const params: Record<string, string> = {
    pid: '1001',
    type: 'wxpay',
    out_trade_no: outTradeNo,
    name: '测试商品',
    money: '1.00',
    notify_url: `http://127.0.0.1:${PORT}/cb`,
    return_url: `http://127.0.0.1:${PORT}/ret`,
    sitename: 'demo',
  };
  const signed = { ...params, sign: epaySign(params, KEY), sign_type: 'MD5' };
  const create = await call('/api/order/create', {
    ...form(signed),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  });
  const created = (await create.json()) as { code: number; msg: string; data?: Record<string, unknown> };
  check('下单成功', created.code === 1, JSON.stringify(created));
  const orderId = String(created.data?.['orderId'] ?? '');
  const price = String(created.data?.['reallyPrice'] ?? '');
  check('返回订单号与金额', !!orderId && price === '1.00', `${orderId} ${price}`);

  const badSign = await call('/api/order/create', {
    ...form({ ...params, sign: 'deadbeef', sign_type: 'MD5' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  });
  check('错误签名被拒', ((await badSign.json()) as { code: number }).code === 0);

  const dup = await call('/api/order/create', {
    ...form(signed),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  });
  const dupJson = (await dup.json()) as { code: number; msg: string };
  check('重复商户订单号被拒', dupJson.code === 0 && dupJson.msg.includes('已存在'), dupJson.msg);

  console.log('\n[5] 支付页与轮询');
  const pay = await call(`/pay/${orderId}`);
  const payHtml = await pay.text();
  check('支付页 200', pay.status === 200, String(pay.status));
  check('支付页显示实付金额', payHtml.includes(price));
  const st0 = (await (await call(`/api/order/status?orderId=${orderId}`)).json()) as {
    data: { status: number };
  };
  check('初始状态为待支付', st0.data.status === 0, String(st0.data.status));

  console.log('\n[6] 监控端心跳与到账推送');
  const tHeart = String(now());
  const hb = await call(
    `/appHeart?t=${tHeart}&pid=1001&sign=${monitorSign([tHeart, '1001'], KEY)}`
  );
  check('心跳成功', ((await hb.json()) as { code: number }).code === 0);

  const tPush = String(now());
  const pushSign = monitorSign(['1', price, tPush, '1001'], KEY);
  const push = await call(
    `/appPush?type=1&price=${price}&t=${tPush}&pid=1001&sign=${pushSign}`
  );
  const pushJson = (await push.json()) as { code: number; msg: string };
  check('到账推送成功', pushJson.code === 0, JSON.stringify(pushJson));

  const st1 = (await (await call(`/api/order/status?orderId=${orderId}`)).json()) as {
    data: { status: number; payTime: number };
  };
  check('订单已标记为已支付', st1.data.status === 1, String(st1.data.status));
  check('支付时间已写入', st1.data.payTime > 0);

  // 重复推送不应重复处理
  const pushAgain = await call(
    `/appPush?type=1&price=${price}&t=${tPush}&pid=1001&sign=${pushSign}`
  );
  const againJson = (await pushAgain.json()) as { code: number; msg: string };
  check('重复推送不重复处理', againJson.msg.includes('已被处理') || againJson.msg.includes('无匹配'), againJson.msg);

  console.log('\n[7] 商户回调');
  await new Promise((r) => setTimeout(r, 400));
  check('收到了回调请求', callbacks.length > 0, `${callbacks.length} 次`);
  const cb = callbacks[0] ?? '';
  check('回调带 TRADE_SUCCESS', cb.includes('trade_status=TRADE_SUCCESS'), cb.slice(0, 120));
  check('回调带商户订单号', cb.includes(encodeURIComponent(outTradeNo)) || cb.includes(outTradeNo));

  console.log('\n[8] 统计口径');
  const stats = (await (await call('/api/stats')).json()) as {
    orders: Record<string, number>;
    passages: number;
    totalOrders: number;
  };
  check('统计里已支付 1 单', (stats.orders['1'] ?? 0) === 1, JSON.stringify(stats.orders));
  check('统计里 1 条可用通道', stats.passages === 1, String(stats.passages));

  console.log('\n[9] 定时任务：关单与金额池释放');
  const cronNoToken = await call('/api/cron/tick');
  check('未配置 token 时 cron 接口关闭', cronNoToken.status === 401, String(cronNoToken.status));
  const cronOk = await call('/api/cron/tick?token=test-cron', {}, { CRON_TOKEN: 'test-cron' });
  check('cron 正常执行', ((await cronOk.json()) as { code: number }).code === 1);

  // 造一笔 10 分钟前的待支付订单，跑 cron 应该被关掉
  const staleNo = `T${Date.now()}s`;
  const staleParams = { ...params, out_trade_no: staleNo, money: '1.00' };
  const staleSigned = { ...staleParams, sign: epaySign(staleParams, KEY), sign_type: 'MD5' };
  const staleCreate = (await (
    await call('/api/order/create', {
      ...form(staleSigned),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    })
  ).json()) as { code: number; data?: Record<string, unknown> };
  check('同金额可再次下单（上一单已释放）', staleCreate.code === 1, JSON.stringify(staleCreate));
  const staleId = String(staleCreate.data?.['orderId'] ?? '');
  await db.patchOrder(staleId, { create_time: now() - 3600 });
  await call('/api/cron/tick?token=test-cron', {}, { CRON_TOKEN: 'test-cron' });
  const staleOrder = await db.getOrder(staleId);
  check('超时订单被关闭', staleOrder?.status === 3, String(staleOrder?.status));

  console.log('\n[10] 后台接口鉴权');
  const adminApi = await call('/api/admin/overview');
  check('未登录拿不到后台数据', adminApi.status !== 200, String(adminApi.status));

  receiver.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail > 0) process.exit(1);
}

await main();
