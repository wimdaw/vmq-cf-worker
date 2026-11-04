/** 页面渲染的公共部分：占位符替换、时间格式化、配置读取 */

import type { Env } from './db';
import { allConfig } from './blob-db';
import { externalHost, externalProto, hostOf } from './util';

const SHANGHAI = 8 * 3600;

/**
 * 静态资源基址（末尾不带斜杠）。
 *
 * 解析顺序：
 *   1) 后台「静态资源地址」（config.resource_url）**存在这一行** → 就用它；
 *      值为空串 = 用相对路径 /static/…（配合 wrangler.jsonc 的 assets 由 Worker 自己分发）
 *   2) 没有这一行 → 回退环境变量 RESOURCE_URL（兼容老部署，全新库不配置也不会白屏）
 */
export function staticBase(cfg: Settings, env: Env): string {
  const raw = Object.prototype.hasOwnProperty.call(cfg, 'resource_url')
    ? (cfg['resource_url'] ?? '')
    : (env.RESOURCE_URL ?? '');
  return raw.trim().replace(/\/+$/, '');
}

/**
 * 把 HTML 里的静态资源绝对路径前缀（/site/、/console/、/static/）重写到外部 CDN 基址。
 *
 * 背景：`resource_url` 原本只作用于服务端渲染的支付页图片（pay.ts 里拼 ${res}/static/…），
 * 而前台 / 后台 SPA 的 JS/CSS/favicon 是 vite 构建时写死的绝对路径（/site/assets/…、
 * /console/assets/…）。要让这些也走 CDN，就在这里做一次性字符串替换 —— 不用改 vite 配置，
 * 也不用手工维护 hash 文件名。
 *
 * @param html   完整的 HTML 字符串
 * @param base   资源基址（末尾不带斜杠），为空串表示不重写（保持相对路径）
 */
export function rewriteAssetUrls(html: string, base: string): string {
  if (!base) return html;
  const prefix = base.replace(/\/+$/, '');
  // 只匹配 src/href 属性里以 /site/、/console/、/static/ 开头的路径，
  // 避免误伤正文里的字符串或其它绝对路径。
  return html.replace(
    /(src|href)="(\/(?:site|console|static)\/[^"]*)"/g,
    (_m, attr: string, path: string) => `${attr}="${prefix}${path}"`
  );
}

/**
 * 注入静态资源基址的**运行时全局变量**，供 bundle 内的动态 import 使用。
 *
 * 为什么需要：懒加载 chunk 的 URL 是 Vite 在打包时用 `renderBuiltUrl` 生成的
 * 运行时代码，形如
 *     window.__VMQ_ASSET_BASE__ + "/console/assets/page-shell-xxx.js"
 * HTML 里的 <script src> 可以由 rewriteAssetUrls 改写，但这段代码在 bundle 内部，
 * 服务端改不到，只能在这里给全局变量赋值。
 *
 * 必须插在 <head> 开头：入口是 <script type="module">（defer 执行），
 * 而普通内联 <script> 同步执行，所以一定会先跑，避免出现 undefined。
 */
export function injectAssetBase(html: string, base: string): string {
  const value = JSON.stringify(base.replace(/\/+$/, '')).replace(/</g, '\\u003c');
  const tag = `<script>window.__VMQ_ASSET_BASE__=${value};</script>`;
  return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
}

/**
 * 站点 host（不带协议）：配置了 site.url 就用它，否则取当前请求的 host。
 * 监控端扫码绑定的地址要靠它，配置里写的是域名时比 req 更准。
 */
export function siteHost(cfg: Settings, req?: Request): string {
  return hostOf(cfg['url'] ?? '') || (req ? externalHost(req) : '');
}

/** 时间戳 → 'Y-m-d H:i:s'（东八区） */
export function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date((ts + SHANGHAI) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export type Settings = Record<string, string>;

export async function loadSettings(env: Env): Promise<Settings> {
  void env;
  return allConfig();
}

/** 站点公共变量：模板里的 {$title} / {$footer} 等 */
export function siteVars(s: Settings): Record<string, unknown> {
  return {
    title: s['title'] ?? 'V免签',
    keywords: s['keywords'] ?? '',
    description: s['description'] ?? '',
    footer: s['footer'] ?? '',
    edition: s['edition'] ?? 'v1.0.0',
    url: s['url'] ?? '',
    // 静态资源根地址：前台 JS 里硬编码的图片路径（demo 页图标）据此拼 CDN 地址。
    // 空串 = 保持相对路径。这里直接取 config 原值（末尾斜杠由前台处理），
    // 与 staticBase 的语义一致（resource_url 存在就用它，否则回退 RESOURCE_URL）。
    resourceUrl: Object.prototype.hasOwnProperty.call(s, 'resource_url')
      ? (s['resource_url'] ?? '')
      : '',
  };
}

export function serverVars(req: Request): Record<string, string> {
  const u = new URL(req.url);
  return {
    // 反代后面要用 X-Forwarded-Host，模板里的绝对链接（支付宝二维码等）才不会指回 Worker 域名
    HTTP_HOST: externalHost(req),
    HTTP_USER_AGENT: req.headers.get('user-agent') ?? '',
    HTTPS: externalProto(req) === 'https' ? 'on' : '',
    REQUEST_URI: u.pathname + u.search,
  };
}

/** 由请求推断协议前缀，拼给模板里的 $http_type */
export function httpType(req: Request): string {
  return `${externalProto(req)}://`;
}
