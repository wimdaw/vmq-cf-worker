import type { Env } from '../lib/db';
import { appSecret, getConfigInt, STATUS } from '../lib/db';
import { enqueueNotify, tryNotifyNow } from '../lib/notify';
import { releasePrice } from '../lib/amount';
import { verifyMonitor } from '../lib/sign';
import { clientIp, json, now, readParams } from '../lib/util';
import {
  addUnmatched,
  findPendingByPrice,
  patchOrder,
  saveConfig,
  setMonitor,
} from '../lib/blob-db';

/** /appHeart —— 监控端心跳 */
export async function handleHeart(req: Request, env: Env): Promise<Response> {
  const p = await readParams(req);
  const key = await appSecret(env);
  if (!key) return json({ code: -1, msg: '通讯密钥未配置' });

  const t = p['t'] ?? '';
  const pid = p['pid'] ?? '';
  const sign = p['sign'] ?? '';

  // 新版含 pid，老版只有 md5(t+key)，两种都接受
  const ok = verifyMonitor([t, pid], sign, key) || verifyMonitor([t], sign, key);
  if (!ok) return json({ code: -1, msg: '签名校验不通过' });

  const ts = now();
  await setMonitor({ last_heart: ts });
  await saveConfig([['jkstate', '1']]);

  return json({ code: 0, msg: '成功' });
}

/**
 * /appPush —— 监控端推送付款通知
 * 参数：type, price, t, pid, sign = md5(type + price + t + pid + key)
 */
export async function handlePush(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const p = await readParams(req);
  const key = await appSecret(env);
  if (!key) return json({ code: -1, msg: '通讯密钥未配置' });

  const type = p['type'] ?? '';
  const price = p['price'] ?? '';
  const t = p['t'] ?? '';
  const pid = p['pid'] ?? '';
  const sign = p['sign'] ?? '';

  const ok = verifyMonitor([type, price, t, pid], sign, key) || verifyMonitor([type, price, t], sign, key);
  if (!ok) return json({ code: -1, msg: '签名校验不通过' });

  // 防重放：旧版 PHP 把这段注释掉了，这里补上（窗口可配，默认 300 秒）
  const window = await getConfigInt(env, 'replay_window_seconds', 300);
  if (window > 0) {
    const tsNum = Number(t);
    if (Number.isFinite(tsNum) && tsNum > 0 && Math.abs(now() - tsNum) > window) {
      return json({ code: -1, msg: '时间戳过期' });
    }
  }

  const ts = now();
  await setMonitor({ last_pay: ts });

  const typeNum = Number(type);
  // 金额唯一性由金额池保证：同一 (金额, 类型) 只可能有一笔待支付订单
  const order = await findPendingByPrice(price, typeNum);

  if (!order) {
    // 不污染订单表，单独记录
    await addUnmatched({ type, price, pid, t, sign, src_ip: clientIp(req), created_at: ts });
    return json({ code: 0, msg: '无匹配订单，已记录' });
  }

  // 标记已支付 + 释放金额占位（状态条件保证重复推送不会重复处理）
  const paid = await patchOrder(
    order.order_id,
    { status: STATUS.PAID, pay_time: ts, close_time: ts },
    STATUS.PENDING
  );
  await releasePrice(env, order.order_id);
  if (!paid) return json({ code: 0, msg: '订单已被处理' });

  // 时间线日志：`lag` = App 签名时间 → 我们处理完成（含网络+App 侧排队），
  // `matchMs` = 请求进来到匹配完成。排查"为什么慢"就看这两个数（wrangler tail 可见）。
  console.log(
    '[appPush] ' +
      JSON.stringify({
        t,
        price,
        type: typeNum,
        order: order?.order_id ?? null,
        lag: ts - Number(t || 0),
        matchMs: Date.now() - started,
      })
  );

  if (!order.notify_url) {
    return json({ code: 0, msg: '成功（未配置回调地址）' });
  }

  // 入队并立刻尝试一次。
  // ⚠️ 用 waitUntil 在后台跑，**绝不能 await**：商户回调最坏要 10 秒（超时），
  // 一旦同步等待，监控端 App 的推送请求会被拖住，用户侧体感就是"到账慢"。
  // 订单在上面已经置为已支付，页面轮询不受影响；回调失败还有 cron 重试兜底。
  const taskId = await enqueueNotify(env, order);
  if (ctx) ctx.waitUntil(tryNotifyNow(env, taskId));
  else await tryNotifyNow(env, taskId); // 本地/测试环境没有 ctx 时退回同步

  return json({ code: 0, msg: '成功' });
}
