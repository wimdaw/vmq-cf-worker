import type { Env, OrderRow } from './db.ts';
import { appSecret, getConfig } from './db.ts';
import { epaySign } from './sign.ts';
import { now } from './util.ts';
import {
  addNotify,
  dueNotify as blobDueNotify,
  getNotify,
  patchOrder,
  saveNotify,
  type NotifyTask,
} from './blob-db.ts';

/** 退避序列（秒）。旧版 PHP 完全没有重试，这里补上。 */
const BACKOFF = [30, 120, 600, 3600, 21600, 21600];
const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;

export function payTypeToName(type: number): string {
  if (type === 1) return 'wxpay';
  if (type === 2) return 'alipay';
  if (type === 4) return 'rmb';
  return String(type);
}

export function nameToPayType(name: string): number | null {
  const n = name.trim().toLowerCase();
  if (n === 'wxpay' || n === 'wechat' || n === 'wx') return 1;
  if (n === 'alipay' || n === 'ali') return 2;
  // QQ 钱包：旧版文档写的是 qqpay:QQ钱包（view/index/doc.html）
  if (n === 'qqpay' || n === 'qq') return 3;
  // 示例页的按钮用的是 rmbpay（见 index/demo.html 的 JS）
  if (n === 'rmb' || n === 'dcep' || n === 'rmbpay') return 4;
  const num = Number.parseInt(n, 10);
  return Number.isFinite(num) ? num : null;
}

/** 构造发给商户的 query string（易支付标准参数） */
export async function buildNotifyPayload(env: Env, order: OrderRow): Promise<string> {
  const key = await appSecret(env);
  const params: Record<string, string> = {
    pid: String(order.pid),
    type: payTypeToName(order.type),
    out_trade_no: order.out_trade_no,
    trade_no: order.order_id,
    trade_status: 'TRADE_SUCCESS',
    money: order.money,
    really_money: order.truemoney,
    name: order.name,
    sitename: order.sitename,
  };
  const sign = epaySign(params, key);
  const qs = new URLSearchParams(params);
  qs.set('sign', sign);
  qs.set('sign_type', 'MD5');
  return qs.toString();
}

export async function enqueueNotify(env: Env, order: OrderRow): Promise<number> {
  const payload = await buildNotifyPayload(env, order);
  return addNotify(order.order_id, order.notify_url, payload, now());
}

/**
 * 判断商户响应是否算回调成功。三种模式（config.notify_success_body）：
 *
 *   `success`（默认）  响应体去首尾空白后**一字不差**等于它（不区分大小写）。
 *                      易支付标准：商户处理完回显 success。
 *   `@any2xx`          只看 HTTP 状态码，2xx 即成功，响应体是什么无所谓。
 *                      商户不回显 success 时的省事选项，但商户侧真失败也判成功。
 *   `@json:字段=值`    把响应体按 JSON 解析，检查字段值。例如 `@json:code=1`
 *                      匹配 {"code":1,...}。适合返回 JSON 的商户：
 *                      比 @any2xx 多一层校验，商户侧拒绝（code=0）会如实判失败。
 *                      数字与字符串都按字符串比对（1 == "1"），字段不存在或
 *                      响应体不是合法 JSON 都判失败。
 */
export function isSuccessBody(body: string, expect: string): boolean {
  const b = body.trim();
  if (expect === '@any2xx') return true; // 只由 HTTP 状态码决定
  if (expect.startsWith('@json:')) {
    const spec = expect.slice('@json:'.length);
    const eq = spec.indexOf('=');
    if (eq <= 0) return false;
    const field = spec.slice(0, eq).trim();
    const want = spec.slice(eq + 1).trim();
    if (!field || !want) return false;
    try {
      const j = JSON.parse(b) as Record<string, unknown>;
      return String(j[field]) === want;
    } catch {
      return false;
    }
  }
  return b.toLowerCase() === expect.trim().toLowerCase();
}

/**
 * 投递一次。返回 true 表示已成功（或任务不存在/已完成）。
 */
export async function deliverTask(env: Env, taskId: number): Promise<boolean> {
  const task = await getNotify(taskId);
  if (!task || task.done === 1) return true;

  const expect = await getConfig(env, 'notify_success_body', '@json:code=1');
  const url = task.url.includes('?') ? `${task.url}&${task.payload}` : `${task.url}?${task.payload}`;

  let ok = false;
  let err = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { 'user-agent': 'vmq-notify/1.0' },
    });
    clearTimeout(timer);
    // ⚠️ 判定必须用**完整**响应体，不能先截断：
    // 商户成功响应里常带 JWT/长 JSON（这里实测 >500 字符），
    // 先 slice 再 JSON.parse 会因字符串不完整而抛错 → 把成功判成失败。
    // 只有写日志/入库时才截断。
    const raw = await res.text();
    ok = res.ok && isSuccessBody(raw, expect);
    if (!ok) err = `HTTP ${res.status} body=${raw.slice(0, 120)}`;
  } catch (e) {
    err = String(e).slice(0, 160);
  }

  if (ok) {
    const done: NotifyTask = { ...task, done: 1, last_error: '' };
    await saveNotify(done);
    // 2 → 1：回调失败过的订单补投成功后转成已支付
    await patchOrder(task.order_id, { status: 1 }, 2);
    return true;
  }

  const attempts = task.attempts + 1;
  const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] ?? 21600;
  const finished = attempts >= MAX_ATTEMPTS ? 1 : 0;

  const next: NotifyTask = {
    ...task,
    attempts,
    next_at: now() + delay,
    done: finished,
    last_error: err,
  };
  await saveNotify(next);
  await patchOrder(task.order_id, { notify_attempts: attempts });

  // 已支付但回调没成功 → 标记 2（后台显示"回调失败"，便于人工补单）
  await patchOrder(task.order_id, { status: 2 }, 1);

  return false;
}

/** 立即尝试一次（失败不抛错，交给 cron 重试） */
export async function tryNotifyNow(env: Env, taskId: number): Promise<void> {
  try {
    await deliverTask(env, taskId);
  } catch (e) {
    console.error('notify immediate failed', e);
  }
}
