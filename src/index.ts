import type { Env } from './lib/db';
import { adminAlias, primeAdminAlias } from './lib/db';
import { runCron } from './cron';
import { handleAdminApi } from './routes/api-admin';
import { handleAgentOne, handleAgentReport, handleAgentState } from './routes/agent';
import { handleHome, handleStats } from './routes/home';
import { handleCheckOrder, handleOrderStatus, handlePayPage } from './routes/pay';
import { handleHeart, handlePush } from './routes/push';
import { handleSetup } from './routes/setup';
import { handleQrCode, handleSitePage, handleUploadGet, isSitePage } from './routes/site';
import { handleSubmit } from './routes/submit';
import { json, readParams } from './lib/util';
import { injectAssetBase, loadSettings, rewriteAssetUrls, staticBase } from './lib/page';

/**
 * 返回后台 SPA 的外壳。
 *
 * 外壳是 assets 里的 /console/index.html，但只在后台入口路径下给出；
 * 不缓存（每次部署 hash 都会变，缓存住旧壳会白屏）。
 * 配了「静态资源地址」时，把 /console/ 的 JS/CSS/favicon 重写到 CDN，
 * 并把基址注入全局变量，供 bundle 内的懒加载 chunk 拼接 URL。
 */
async function serveSpa(env: Env, url: URL): Promise<Response> {
  const shell = await env.ASSETS.fetch(new URL('/console/index.html', url));
  const settings = await loadSettings(env);
  const base = staticBase(settings, env);
  const out = rewriteAssetUrls(injectAssetBase(await shell.text(), base), base);
  return new Response(out, {
    status: shell.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 路由表。监控端和旧站相关的路径保持原样（/appPush、/checkOrder、/enQrcode），
 * 这样监控端 App 和已经对接过旧站的商户代码都不用改。
 * 商户下单对外用 /api/order/create，旧地址 /submit.php 只作兼容入口保留。
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 首次初始化向导：只在没有任何管理员时可用，已初始化的实例一律 404。
    // 必须在后台路由之前判断（免得别名恰好是 setup 时被抢走）。
    if (path === '/setup') return handleSetup(req, env);

    // 后台 JSON API（新 SPA 用）：固定前缀 /api/admin，与后台别名无关。
    // 放在 primeAdminAlias 之前 —— 这个前缀不需要别名，省掉一次 config 查询。
    if (path === '/api/admin' || path.startsWith('/api/admin/')) {
      return handleAdminApi(req, env, path.slice('/api/admin'.length) || '/');
    }

    // env 里没配 ADMIN_ALIAS 时（开源版由 /setup 写入 config），这里才查一次库并缓存 60 秒；
    // 配了的话直接返回，不会产生查询。
    await primeAdminAlias(env);

    // 后台入口已经是 SPA（React + shadcn），外壳由 assets 提供。
    // 前端用 hash 路由，所以只需要一个入口路径，深链接形如 /别名/#/orders。
    const alias = adminAlias(env);

    // 构建产物目录本身不对外：知道 /console 就能打开登录页的话，
    // 「别名藏后台」这层遮挡就白做了。统一跳回别名入口。
    if (path === '/console' || path === '/console/index.html') {
      return new Response(null, { status: 302, headers: { Location: `/${alias}${url.search}` } });
    }

    // 若配置了自定义别名（且不为 admin），访问默认 /admin 统一重定向到别名入口
    if (alias && alias !== 'admin' && (path === '/admin' || path.startsWith('/admin/'))) {
      const rest = path.slice('/admin'.length);
      return new Response(null, { status: 302, headers: { Location: `/${alias}${rest}${url.search}` } });
    }

    // 后台的所有路径都返回 SPA 外壳：前端用 hash 路由，路径本身不带语义。
    // 旧后台地址（/别名/system.passage/index 之类）同样落到 SPA 首页，
    // 不再渲染第三方 layui 模板 —— 旧页面已随模板一并移除。
    for (const prefix of new Set([`/${alias}`, '/admin'])) {
      if (path === prefix || path.startsWith(`${prefix}/`)) return serveSpa(env, url);
    }

    // 监控端（路径与旧版一致，App 不用改）
    if (path === '/appPush' || path === '/index/pay/appPush') return handlePush(req, env, ctx);
    if (path === '/appHeart' || path === '/index/pay/appHeart') return handleHeart(req, env);

    // 桌面监控端（Windows / macOS / Linux）的统一接入点。
    // 三端推同一份 Report，服务端按 agent_id 覆盖式保存最新快照。
    if (path === '/api/agent/report') return handleAgentReport(req, env);
    if (path === '/api/agent/state') return handleAgentState(req, env);
    if (path.startsWith('/api/agent/state/')) {
      return handleAgentOne(req, env, decodeURIComponent(path.slice('/api/agent/state/'.length)));
    }

    // 商户下单。三个地址指向同一个处理器：
    //   /api/order/create —— 对外文档用的规范地址，和 /api/order/status 成对（建单 / 查单）
    //   /submit.php、/submit —— 旧版 PHP 站的入口。不对外宣传，但保留着：
    //     已经按旧站写死的商户代码、以及从旧站迁移过来的人，不用改一行就能用
    if (path === '/api/order/create' || path === '/submit.php' || path === '/submit') {
      return handleSubmit(req, env);
    }

    // 支付页与订单状态
    if (path === '/checkOrder' || path === '/index/pay/checkOrder') {
      // foot.html 用 POST body 传 orderId，也兼容 query
      const p = req.method === 'POST' ? await readParams(req) : {};
      const orderId = p['orderId'] ?? url.searchParams.get('orderId') ?? '';
      return handleCheckOrder(env, orderId);
    }
    if (path === '/api/order/status') {
      return handleOrderStatus(env, url.searchParams.get('orderId') ?? '');
    }
    if (path.startsWith('/pay/') && path !== '/pay') {
      return handlePayPage(env, req, path.slice('/pay/'.length));
    }
    // 旧版的支付页入口是 /index/pay/page?trade_no=xxx，保留以兼容老链接
    if (path === '/index/pay/page') {
      return handlePayPage(env, req, url.searchParams.get('trade_no') ?? '');
    }

    // 二维码（旧版由 PHP 生成，这里用内置编码器）
    if (path === '/enQrcode') return handleQrCode(req);

    // 后台上传的图片
    if (path.startsWith('/upload/')) return handleUploadGet(env, path.slice('/upload/'.length));

    // 静态资源随 Worker 发布（public/static），由 assets 直接分发，正常不会走到这里。
    // 只有资源缺失时才回落：配了 RESOURCE_URL 就 302 过去兜底，没配直接 404
    // —— 之前这里对 undefined 调 .replace 会抛错，表现为 500。
    if (path.startsWith('/static/')) {
      const res = (env.RESOURCE_URL ?? '').replace(/\/+$/, '');
      if (res) return Response.redirect(`${res}${path}${url.search}`, 302);
      return json({ code: 404, msg: 'Not Found' }, 404);
    }
    // favicon 由 public/favicon.ico 提供（assets 分发），不再跳旧资源站

    // 健康检查 / 服务状态面板
    if (path === '/api/health') return json({ ok: true, ts: Math.floor(Date.now() / 1000) });
    if (path === '/__status') return handleHome(env);
    if (path === '/api/stats') return handleStats(env);

    // 站点前台页面（首页 / 文档 / 示例 / 查单）
    if (isSitePage(path)) return handleSitePage(req, env, path);

    return json({ code: 404, msg: 'Not Found' }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
