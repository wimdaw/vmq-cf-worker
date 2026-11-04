/**
 * 后台登录：验证码签发与登录校验。
 *
 * 这两个处理器原本和 layui 后台页面放在一起，旧页面移除后它们仍被 SPA 使用
 * （api-admin.ts 的 /login、/captcha），因此单独留在路由层。
 *
 * 验证码是「无状态」的：code 与过期时间签名后塞进 cookie（vmq_cap），
 * 对比时再解出来验签，不占数据库。签名密钥与后台会话共用 admin_secret。
 */
import type { Env } from '../lib/db';
import { getConfig } from '../lib/db';
import {
  adminSecret,
  b64u,
  captchaSvg,
  issueCookie,
  newCaptcha,
  sign,
  verifyPassword,
  verifySig,
} from '../lib/auth';
import { json, now, readParams } from '../lib/util';
import * as contentRepo from '../modules/content/content.repository';
import { findAdminForLogin, updateLoginTime } from '../modules/system/system.repository';

const CAP_COOKIE = 'vmq_cap';

function clientIpOf(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? '';
}

/** 写操作日志。日志失败不影响主流程 */
function addLog(env: Env, uid: number, content: string, ip: string): Promise<void> {
  void env;
  return contentRepo.addLog(uid, content, ip);
}

export async function handleCaptcha(env: Env): Promise<Response> {
  const code = newCaptcha();
  const secret = await adminSecret(env);
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `${code.toUpperCase()}.${exp}`;
  const sig = await sign(payload, secret);
  return new Response(captchaSvg(code), {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': `${CAP_COOKIE}=${b64u(new TextEncoder().encode(payload))}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`,
    },
  });
}

async function checkCaptcha(req: Request, env: Env, input: string): Promise<boolean> {
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${CAP_COOKIE}=([^;]+)`).exec(cookie);
  if (!m) return false;
  const [p, sig] = (m[1] ?? '').split('.');
  if (!p || !sig) return false;
  const secret = await adminSecret(env);
  const payload = new TextDecoder().decode(
    Uint8Array.from(
      atob(p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4)),
      (c) => c.charCodeAt(0)
    )
  );
  if (!(await verifySig(payload, sig, secret))) return false;
  const [code, expStr] = payload.split('.');
  if (!code || Number(expStr) < Math.floor(Date.now() / 1000)) return false;
  return code === input.trim().toUpperCase();
}

export async function handleLoginPost(req: Request, env: Env): Promise<Response> {
  const p = await readParams(req);
  const username = (p['username'] ?? '').trim();
  const password = p['password'] ?? '';
  const captcha = p['captcha'] ?? '';

  const requireCaptcha = (await getConfig(env, 'admin_captcha', '1')) === '1';
  if (requireCaptcha && !(await checkCaptcha(req, env, captcha))) {
    return json({ code: 0, msg: '验证码错误' });
  }

  const row = await findAdminForLogin(username);

  if (!row || row.status !== 1 || !(await verifyPassword(password, row.password_hash))) {
    return json({ code: 0, msg: '账号或密码错误' });
  }

  await updateLoginTime(row.id);
  await addLog(env, row.id, `登录后台`, clientIpOf(req));

  const res = json({ code: 1, msg: '登录成功' });
  res.headers.append('set-cookie', await issueCookie(env, username, row.id));
  return res;
}
