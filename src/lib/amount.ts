import type { Env } from './db';
import { getConfigInt } from './db';
import { acquirePool, releasePool } from './blob-db';

/**
 * 金额池：把"分-类型"作为 key 占位。
 *
 * 与旧版（php）完全一致的策略：
 *   条件写抢占（等价 INSERT OR IGNORE）→ 失败就按 payQf 调整 1 分 → 最多试 10 次
 *
 * EdgeOne 版没有自增主键冲突，改用 Blob 的 onlyIfNew 条件写：
 * 同一个 key 并发写入只有一笔成功，语义与原表主键互斥一致。
 *
 * @returns 分配成功返回实际应付分值；失败返回 null
 */
export async function allocatePrice(
  env: Env,
  fen: number,
  type: number,
  oid: string
): Promise<number | null> {
  const payQf = await getConfigInt(env, 'payQf', 1);
  let cur = fen;

  for (let i = 0; i < 10; i++) {
    if (cur <= 0) return null;
    if (await acquirePool(cur, type, oid)) return cur;
    cur += payQf === 2 ? -1 : 1;
  }
  return null;
}

/** 支付成功或订单关闭时释放占位 */
export async function releasePrice(env: Env, oid: string): Promise<void> {
  void env;
  await releasePool(oid);
}

/** 分 → 元，保留两位（避免浮点误差） */
export function fenToYuan(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(fen);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 元 → 分 */
export function yuanToFen(yuan: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(yuan)) return null;
  const [intPart, decPart = ''] = yuan.split('.');
  return Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
}
