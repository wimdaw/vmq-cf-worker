/**
 * 统计查询。
 *
 * 所有"按天"的口径都固定用 Asia/Shanghai（+8，无夏令时），
 * 与后台看板、模板里的时间显示保持一致 —— 这里不用 UTC。
 *
 * EdgeOne 版没有 SQL 聚合：摘要按「月」存在 Blob 上（odx/YYYY-MM），
 * 统计口径全部在 lib/blob-db.ts 里现算，进程内缓存 5 秒。
 */
import { dailyPaid as blobDailyPaid, getMonitor, paidSince as blobPaidSince, paidTotals as blobPaidTotals } from '../../lib/blob-db';

const SHANGHAI = 8 * 3600;

/** 今天 0 点（上海时区）的 unix 秒；offset 为往前推的天数 */
export function dayStart(ts: number, offset = 0): number {
  const d = new Date((ts + SHANGHAI) * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000) - SHANGHAI - offset * 86400;
}

/** 某天的"天序号"（用于按天分组对齐） */
function dayKey(ts: number): number {
  return Math.floor((ts + SHANGHAI) / 86400);
}

/** 该时间戳对应的上海日期（YYYY-MM-DD），给看板的每日明细当标签用 */
export function dayLabel(ts: number): string {
  const d = new Date((ts + SHANGHAI) * 1000);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

export interface Totals {
  c: number;
  s: number;
}

/** 累计已收（status 1/2 都算钱已到账：1=回调成功，2=回调失败但钱到了） */
export async function paidTotals(): Promise<Totals> {
  return blobPaidTotals();
}

/** 指定时刻之后的已收 */
export async function paidSince(since: number): Promise<Totals> {
  return blobPaidSince(since);
}

/** 按天聚合（返回 dayKey → 汇总） */
export async function dailyPaid(since: number): Promise<Map<number, Totals>> {
  return blobDailyPaid(since);
}

/** 监控端最后一次心跳（0 = 从没连过） */
export async function lastHeart(): Promise<number> {
  const m = await getMonitor();
  return Number(m.last_heart ?? 0);
}

export { dayKey };
