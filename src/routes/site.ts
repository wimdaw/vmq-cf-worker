/** 站点前台页面（首页 / 文档 / 示例 / 查单）以及二维码、上传资源输出 */

import type { Env } from '../lib/db';
import { injectAssetBase, loadSettings, rewriteAssetUrls, siteVars, staticBase } from '../lib/page';
import { createDemoOrder } from '../lib/order';
import { qrPng } from '../lib/qr';
import { getUpload } from '../lib/blob-db';
import { clientIp, html, publicUrl, text } from '../lib/util';

/**
 * 路径 → 构建产物。
 *
 * 只提供带 `.html` 的地址（伪静态）。前台还没上线，不存在需要兼容的旧链接，
 * 所以不做无后缀别名 —— 两套地址同时 200 只会让「哪个是规范地址」变含糊，
 * 也是搜索引擎眼里的重复内容。唯一例外是根路径 `/`，它本身就是入口。
 */
const PAGES: Record<string, { file: string; title: string }> = {
  '/': { file: 'index.html', title: '' },
  '/index.html': { file: 'index.html', title: '' },
  '/doc.html': { file: 'doc.html', title: '页面跳转支付' },
  '/api.html': { file: 'api.html', title: 'API 接口支付' },
  '/demo.html': { file: 'demo.html', title: '支付体验' },
  '/result.html': { file: 'result.html', title: '支付结果通知' },
  '/chaorder.html': { file: 'chaorder.html', title: '单笔订单查询' },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char);
}

function injectPage(shell: string, vars: Record<string, unknown>, pageTitle: string): string {
  const settings = {
    title: String(vars.title ?? 'V免签'),
    description: String(vars.description ?? ''),
    footer: String(vars.footer ?? ''),
    edition: String(vars.edition ?? ''),
    // 前台 JS 里硬编码的图片路径（demo 页图标）据此拼 CDN 地址
    resourceUrl: String(vars.resourceUrl ?? ''),
  };
  const title = pageTitle ? `${pageTitle} - ${settings.title}` : settings.title;
  const description = settings.description || '轻量、清晰的支付接入方案';
  const keywords = String(vars.keywords ?? '');
  const config = JSON.stringify(settings)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  // 注意结尾的 `\s*\/?>`：Vite 产出的是 XHTML 风格的 `<meta ... />`（带斜杠），
  // 只写 `">` 的话正则永远不命中 —— 设置里的 description/keywords 会被静默丢弃。
  // 改这里请保持两种写法都能匹配（旧模板是不带斜杠的）。
  return shell
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, () => `<meta name="description" content="${escapeHtml(description)}">`)
    .replace(/<meta name="keywords" content="[^"]*"\s*\/?>/, () => `<meta name="keywords" content="${escapeHtml(keywords)}">`)
    .replace(
      /(<script id="site-config" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_match, prefix, suffix) => `${prefix}${config}${suffix}`
    );
}

export function isSitePage(path: string): boolean {
  return path in PAGES;
}

export async function handleSitePage(req: Request, env: Env, path: string): Promise<Response> {
  const page = PAGES[path];
  if (!page) return text('404', 404);

  // 示例页「立即支付」：带 type/money 参数 = 真下单并跳支付页（旧版行为）。
  // 判断用 page.file 而不是 path —— /demo 和 /demo.html 两个地址都要走这条分支，
  // 只比对 path 的话伪静态地址会把下单当成普通页面渲染。
  if (page.file === 'demo.html') {
    const q = new URL(req.url).searchParams;
    const type = (q.get('type') ?? '').trim();
    const money = (q.get('money') ?? '').trim();
    if (type && money) {
      return demoCheckout(req, env, type, money, q.get('out_trade_no') ?? '');
    }
  }

  const shell = await env.ASSETS.fetch(new URL(`/site/${page.file}`, req.url));
  if (!shell.ok) return text('前台构建产物缺失，请先执行 pnpm web:build', 500);

  const settings = await loadSettings(env);
  const vars = siteVars(settings);
  const base = staticBase(settings, env);
  const out = rewriteAssetUrls(injectAssetBase(injectPage(await shell.text(), vars, page.title), base), base);
  return new Response(out, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 示例页下单：成功后 302 到支付页（旧版跳 /index/pay/page?trade_no=）
 * 失败时给一页可读的错误提示，而不是白屏或 JSON。
 */
async function demoCheckout(
  req: Request,
  env: Env,
  type: string,
  money: string,
  outTradeNo: string
): Promise<Response> {
  const r = await createDemoOrder(env, type, money, outTradeNo, clientIp(req));
  if (!r.ok || !r.order) return html(demoErrorPage(r.msg));

  // 反代场景用 publicUrl：用户从哪个域名进来就还回哪个，不会跳到 workers.dev
  return Response.redirect(publicUrl(req, `/pay/${r.order.order_id}`), 302);
}

function demoErrorPage(msg: string): string {
  const safe = msg.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c
  );
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>体验下单失败</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f5f5f5;margin:0;padding:40px 20px}
.box{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:17px;color:#333;margin:0 0 12px}p{color:#888;font-size:14px;line-height:1.7;margin:0}
a{display:inline-block;margin-top:16px;color:#1f6feb;text-decoration:none;font-size:14px}</style></head>
<body><div class="box"><h1>体验下单失败</h1><p>${safe}</p><a href="/demo.html">返回体验页</a></div></body></html>`;
}

/** /enQrcode?url=xxx → PNG 二维码（旧版由 PHP 生成，这里用内置编码器） */
export async function handleQrCode(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const data = url.searchParams.get('url') ?? '';
  if (!data) return text('missing url', 400);
  if (data.length > 900) return text('url too long', 400);

  const scale = Math.min(12, Math.max(3, Number(url.searchParams.get('size') ?? '6') || 6));
  try {
    const png = await qrPng(data, scale, 4);
    return new Response(png, {
      headers: {
        'content-type': 'image/png',
        // 内容是收款码地址，一般不变，可短缓存
        'cache-control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return text(`二维码生成失败: ${String(e).slice(0, 120)}`, 500);
  }
}

/** 后台图片上传后的访问地址：/upload/:hash */
export async function handleUploadGet(env: Env, hash: string): Promise<Response> {
  void env;
  const file = await getUpload(hash);
  if (!file) return text('not found', 404);
  return new Response(file.bytes, {
    headers: {
      'content-type': file.mime,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
