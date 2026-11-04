/** 时间/参数/响应等基础工具 */

export const now = (): number => Math.floor(Date.now() / 1000);

const SHANGHAI_OFFSET = 8 * 3600;

/** 按 Asia/Shanghai 输出 YmdHms（中国无夏令时，固定 +8 即可） */
export function fmtYmdHms(ts: number): string {
  const d = new Date((ts + SHANGHAI_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** 同时读取 query 和 urlencoded body；监控端 GET/POST 都可能 */
export async function readParams(req: Request): Promise<Record<string, string>> {
  // 用数组累积：PHP/jQuery 的数组语法 id[]=5&id[]=3 要能合并成 "5,3"
  // （后台批量删除就是 $.post(url, { id: ids })，不处理会丢参数报「缺少 id」）
  const acc: Record<string, string[]> = {};
  const add = (rawKey: string, v: string) => {
    const k = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey;
    (acc[k] ??= []).push(v);
  };

  new URL(req.url).searchParams.forEach((v, k) => {
    add(k, v);
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      try {
        const form = await req.formData();
        form.forEach((v, k) => {
          if (typeof v === 'string') add(k, v);
        });
      } catch {
        /* 忽略解析失败 */
      }
    } else if (ct.includes('application/json')) {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        for (const [k, v] of Object.entries(body)) {
          if (v !== null && v !== undefined) {
            // JSON 里的数组 [1,2] → "1,2"
            add(k, Array.isArray(v) ? v.join(',') : String(v));
          }
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  const out: Record<string, string> = {};
  for (const [k, vs] of Object.entries(acc)) out[k] = vs.join(',');
  return out;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function text(body: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? '';
}

/** 判断是否为 EdgeOne 内部网关地址（云函数收到的 host 会被内部代理重写成该域名） */
export function isInternalHost(host: string): boolean {
  return /qcloudteo\.com$|pages-scf-|pages-pro-/i.test(host);
}

/**
 * 对外访问域名。
 *
 * EdgeOne 云函数运行时会把请求 URL 与 host 头重写为内部网关地址
 * （如 pages-pro-xxx.pages-scf-hk-pro.qcloudteo.com），真实访问域名通过
 * `eo-pages-host` 头传递，故优先读取；其次 x-forwarded-host，
 * 再次未重写的 host 头，最后回退请求 URL。
 */
export function externalHost(req: Request): string {
  const candidates = [
    req.headers.get('eo-pages-host'),
    req.headers.get('x-forwarded-host'),
    req.headers.get('x-host'),
    req.headers.get('host'),
  ];
  for (const candidate of candidates) {
    const host = candidate?.split(',')[0].trim();
    if (host && !isInternalHost(host)) {
      return host;
    }
  }
  const urlHost = new URL(req.url).host;
  return isInternalHost(urlHost) ? '' : urlHost;
}

/** 对外协议：同理优先 X-Forwarded-Proto */
export function externalProto(req: Request): 'http' | 'https' {
  const xf = (req.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
  if (xf === 'http' || xf === 'https') return xf;
  return new URL(req.url).protocol === 'http:' ? 'http' : 'https';
}

/** 拼一个用户视角的绝对地址（反代场景下不会串到 Worker 域名） */
export function publicUrl(req: Request, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${externalProto(req)}://${externalHost(req)}${p}`;
}

/**
 * 取「纯域名」（不带协议、不带端口以外的路径）：
 *   'https://pay.example.com/'  → 'pay.example.com'
 *   'pay.example.com/sub'       → 'pay.example.com'
 *   ''                          → ''
 *
 * 后台「站点地址」是手填的，写成不带协议、带尾斜杠、甚至带子路径都有可能，
 * 而监控端 App 要的就是一个能拼 `http://host/appPush` 的裸 host，这里统一兜住。
 */
export function hostOf(v: string): string {
  const s = v.trim();
  if (!s) return '';
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).host;
  } catch {
    // 不是合法 URL（比如含空格），退化成去掉首尾斜杠原样返回，总比报错好
    return s.replace(/^\/+|\/+$/g, '');
  }
}

/**
 * 取「协议 + 域名」：`pay.example.com/` → `https://pay.example.com`。
 *
 * 监控端 App 的绑定串必须带协议（它直接拿这个 origin 去请求 /appPush），
 * 所以不能只给裸域名。
 *
 * 协议选择：**默认一律 https**。
 * 只有本机调试地址（localhost / 127.0.0.1 / [::1]）且明确写了 http:// 时才保留 http。
 * 这样即使管理员是用 http 打开的网站（没开 Always Use HTTPS），
 * 生成的绑定串也不会变成 http —— 新版 Android 默认禁止明文请求，会直接连不上。
 */
export function originOf(v: string): string {
  const host = hostOf(v);
  if (!host) return '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const explicitHttp = /^http:\/\//i.test(v.trim());
  return local && explicitHttp ? `http://${host}` : `https://${host}`;
}

/** 定长比较，避免签名比较的时序差异 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 生成 n 字节的随机十六进制串（默认 16 字节 → 32 位）。密钥、验证码兜底都用它 */
export function randHex(bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const x of buf) out += x.toString(16).padStart(2, '0');
  return out;
}
