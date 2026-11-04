import { getConfig as blobGetConfig, saveConfig } from './blob-db';

export type { OrderRow, PassageRow, AdminDoc } from './types';
export { STATUS } from './types';

/**
 * EdgeOne 运行环境。
 *
 * 与 Cloudflare 版的区别：没有 D1 绑定（数据走 Blob，见 blob-db.ts），
 * 静态资源不由函数分发（SPA 外壳在构建期内嵌，其余由平台直接给）。
 */
export interface Env {
  /** 构建期内嵌的 SPA 外壳读取器（本地 dev 与 EdgeOne 都用它） */
  ASSETS: { fetch(url: URL | string): Promise<Response> };
  /** 静态资源前缀（可选）：配了就作为兜底基址，不配则用相对路径 /static */
  RESOURCE_URL: string;
  /** 后台入口别名（旧版叫 admin_alias_name），默认 admin */
  ADMIN_ALIAS?: string;
  /** 可选：首次初始化的令牌。配了之后 /setup 必须带同样的 ?token=，防止被人抢先初始化 */
  SETUP_TOKEN?: string;
  /** 可选：定时任务令牌。配了之后 /api/cron/tick 必须带 ?token= */
  CRON_TOKEN?: string;
}

/**
 * 后台入口别名。
 *
 * 两种来源：
 *   1) `ADMIN_ALIAS` 环境变量 —— 生产用这条，**零 IO**（行为与之前一致）
 *   2) 开源版在 /setup 里自定义，写进 config.admin_alias，由 [primeAdminAlias] 预热到进程缓存
 *
 * 缓存 60 秒；env 配了的话连缓存都不用。
 */
let aliasCache: { v: string; exp: number } | null = null;
const ALIAS_TTL_MS = 60_000;

function normAlias(v: string): string {
  return v.trim().replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'admin';
}

export function adminAlias(env: Env): string {
  if (env.ADMIN_ALIAS) return normAlias(env.ADMIN_ALIAS);
  if (aliasCache && aliasCache.exp > Date.now()) return aliasCache.v;
  return 'admin';
}

/** 请求入口调一次：env 没配时才去 config 读（配了直接返回，不产生 IO）。force=true 跳过缓存 */
export async function primeAdminAlias(env: Env, force = false): Promise<void> {
  if (env.ADMIN_ALIAS) return;
  if (!force && aliasCache && aliasCache.exp > Date.now()) return;
  try {
    aliasCache = { v: normAlias(await blobGetConfig('admin_alias')), exp: Date.now() + ALIAS_TTL_MS };
  } catch {
    // 配置还没写（尚未初始化）：缓存默认值，避免每个请求都白读一次
    aliasCache = { v: 'admin', exp: Date.now() + ALIAS_TTL_MS };
  }
}

/** /setup 写完别名后立即生效，不用等缓存过期 */
export function setAdminAliasCache(v: string): void {
  aliasCache = { v: normAlias(v), exp: Date.now() + ALIAS_TTL_MS };
}

export async function getConfig(env: Env, key: string, def = ''): Promise<string> {
  void env;
  return blobGetConfig(key, def);
}

export async function getConfigInt(env: Env, key: string, def: number): Promise<number> {
  const v = await getConfig(env, key, String(def));
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * 应用密钥（平台唯一一把）。
 *
 * 兼容性约定：监控端签名与商户签名**共用同一把**通讯密钥（旧版就是这个设计），
 * 三条链路的签名串分别是：
 *   appPush    : md5(type + price + t + pid + KEY)
 *   appHeart   : md5(t + pid + KEY)
 *   submit.php : md5(签名串 + KEY)   易支付标准签名串
 *
 * 取值顺序（兼容历史配置）：app_key → key → epaykey_ali
 */
export async function appSecret(env: Env): Promise<string> {
  for (const k of ['app_key', 'key', 'epaykey_ali']) {
    const v = await getConfig(env, k);
    if (v) return v;
  }
  return '';
}

export async function setConfig(env: Env, key: string, value: string): Promise<void> {
  void env;
  await saveConfig([[key, value]]);
}
