import type { Env } from './lib/db';
import { getConfigInt, STATUS } from './lib/db';
import { deliverTask } from './lib/notify';
import { now } from './lib/util';
import { releasePrice } from './lib/amount';
import {
  dueNotify,
  getMonitor,
  listOrders,
  patchOrder,
  saveConfig,
  sweepPool,
} from './lib/blob-db';

/**
 * 每分钟跑一次（EdgeOne: edgeone.json 的 schedules → POST /api/cron/tick，
 * 另有「请求内惰性触发」兜底，见 edgeone-entry.ts）。
 *
 * 旧版 PHP 是把清理逻辑挂在 createOrder / appHeart / appPush 开头，靠流量驱动；
 * Worker 版改成真正的定时任务，EdgeOne 版两条都保留 —— 平台的 cron 最小间隔
 * 文档写的是「一天」，实际按分钟配置能不能生效要看账号，所以不能只依赖它。
 *
 * ⚠️ 可能重复触发，所以每条语句都必须幂等（都带了 status 条件限定）。
 */
export async function runCron(env: Env): Promise<void> {
  const ts = now();

  // 1) 心跳超时 → 标记监控端离线
  const st = await getMonitor();
  if (!st.last_heart || ts - st.last_heart > 60) {
    await saveConfig([['jkstate', '0']]);
  }

  // 2) 关闭超时订单并释放金额占位
  const closeMin = await getConfigInt(env, 'close', 5);
  const cutoff = ts - closeMin * 60;
  const expired = await listOrders({
    status: STATUS.PENDING,
    endTs: cutoff,
    limit: 100,
    offset: 0,
  });

  for (const row of expired.rows) {
    const done = await patchOrder(
      row.order_id,
      { status: STATUS.EXPIRED, close_time: ts },
      STATUS.PENDING
    );
    if (done) await releasePrice(env, row.order_id);
  }

  // 3) 回调重试
  const due = await dueNotify(ts, 20);
  for (const id of due) {
    try {
      await deliverTask(env, id);
    } catch (e) {
      console.error('notify retry failed', id, e);
    }
  }

  // 4) 清理孤儿金额占位（oid 已不对应任何待支付订单）
  await sweepPool();
}
