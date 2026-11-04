/**
 * EdgeOne Makers Cloud Functions 入口。
 *
 * 平台约定：`cloud-functions/**` 里导出 `onRequest(context)` 的文件就是一个路由，
 * 构建器会自动打成一个 Node 函数；静态资源优先于函数，所以这里只在
 * 「没有同名静态文件」时才会被调到。
 *
 * 这个文件做四件 Cloudflare 侧不存在的事：
 *   1. 把 `context.request` 物化（Node 运行时在高并发下共享流会读串）
 *   2. 拼出 Worker 期望的 `env`（没有 D1 绑定，也没有 assets 绑定）
 *   3. 给 `ExecutionContext` 打个垫片（`waitUntil` 在 Node 运行时里没有）
 *   4. 提供 `/api/cron/tick`（平台的 schedules 打这里）＋ 请求内惰性兜底
 */
import worker from './index';
import type { Env } from './lib/db';
import { runCron } from './cron';
import { fetchShell } from './lib/shells';
import { json } from './lib/util';

const waitUntilPool = new Set<Promise<unknown>>();

/** Node 运行时没有 ExecutionContext，这里给出 Worker 代码用到的那两个方法 */
function executionCtx() {
  return {
    waitUntil(p: Promise<unknown>) {
      waitUntilPool.add(p);
      p.catch(() => {}).finally(() => waitUntilPool.delete(p));
    },
    passThroughOnException() {
      /* 没有等价能力，出错就让框架返回 500 */
    },
  };
}

function buildEnv(context: unknown): Env {
  const ctxEnv = (context as { env?: Record<string, string> })?.env ?? {};
  const read = (k: string): string => String(ctxEnv[k] ?? process.env[k] ?? '');
  return {
    // 静态资源里只有「SPA 外壳」需要经过函数（注入站点配置），
    // 真正的 JS/CSS 由平台直接分发，不占函数带宽
    ASSETS: { fetch: (url: URL | string) => fetchShell(new URL(String(url), 'http://local').pathname) },
    RESOURCE_URL: read('RESOURCE_URL'),
    ADMIN_ALIAS: read('ADMIN_ALIAS') || undefined,
    SETUP_TOKEN: read('SETUP_TOKEN') || undefined,
    CRON_TOKEN: read('CRON_TOKEN') || undefined,
  };
}

/**
 * 请求体物化。
 *
 * EdgeOne 的 Node 运行时把请求体当惰性流交给 handler，多个并发请求同时读会竞态
 * （表现为 `Invalid JSON body` / 表单解析失败）。这里一次性读成 ArrayBuffer，
 * 再构造一个新的 Web Request 交给下游。请求体上限 6MB，这里都是小包。
 */
async function materialize(req: Request): Promise<Request> {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return req;
  try {
    const buf = await req.arrayBuffer();
    return new Request(req.url, {
      method,
      headers: req.headers,
      body: buf.byteLength > 0 ? buf : undefined,
    });
  } catch {
    return req;
  }
}

/* ------------------------------ 定时任务 ------------------------------ */

let lastLazyCron = 0;

/**
 * 惰性触发：平台 schedules 有最小粒度限制（文档写的是「最小间隔一天」，
 * 与「精度一分钟」的说法自相矛盾，能不能按分钟跑要看账号），
 * 所以只要有请求进来，就顺手补一次 cron —— 原 PHP 版本来就是流量驱动的。
 * 每个实例每分钟最多一次。
 */
function lazyCron(env: Env): void {
  const nowMs = Date.now();
  if (nowMs - lastLazyCron < 60_000) return;
  lastLazyCron = nowMs;
  void runCron(env).catch((e) => console.error('[cron] lazy run failed', e));
}

async function handleCronTick(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const expect = env.CRON_TOKEN ?? '';
  if (!expect) {
    return json(
      { code: 0, msg: '未配置 CRON_TOKEN，定时任务接口已关闭（惰性 cron 仍在生效）' },
      401
    );
  }
  const provided = url.searchParams.get('token') ?? req.headers.get('x-cron-token') ?? '';
  if (provided !== expect) return json({ code: 0, msg: 'token 不匹配' }, 403);

  await runCron(env);
  lastLazyCron = Date.now();
  return json({ code: 1, msg: 'ok' });
}

/* -------------------------------- 入口 -------------------------------- */

export async function onRequest(context: unknown): Promise<Response> {
  const incoming = (context as { request: Request }).request;
  const env = buildEnv(context);
  const url = new URL(incoming.url);

  if (url.pathname === '/api/cron/tick') {
    return handleCronTick(await materialize(incoming), env);
  }

  lazyCron(env);

  const req = await materialize(incoming);
  const res = await worker.fetch(req, env, executionCtx() as unknown as ExecutionContext);

  // 函数返回后 Node 进程不会立刻退出，把后台任务挂一下，避免被提前回收
  if (waitUntilPool.size > 0) {
    await Promise.race([
      Promise.allSettled([...waitUntilPool]),
      new Promise((r) => setTimeout(r, 200)),
    ]);
  }

  return res;
}

export default { onRequest };
