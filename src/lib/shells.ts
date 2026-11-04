/**
 * 构建期内嵌的 HTML 外壳。
 *
 * 平台的静态资源优先级高于 Functions：只要 `site/index.html` 以静态文件存在，
 * 请求 `/` 就永远不会进函数，也就没法注入站点配置。所以这些外壳**不进静态目录**，
 * 由 scripts/eo-build.mjs 在打包时以虚拟模块（virtual:vmq-shells）内嵌进函数包。
 */
import { SHELLS } from 'virtual:vmq-shells';

export function shellOf(path: string): string | null {
  return SHELLS[path] ?? null;
}

/** 供 ASSETS 垫片使用：未命中返回 404，与 Worker 的 assets 行为一致 */
export async function fetchShell(path: string): Promise<Response> {
  const html = shellOf(path);
  if (html === null) return new Response('not found', { status: 404 });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
