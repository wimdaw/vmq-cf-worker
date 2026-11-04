/**
 * 通道（收款账号）数据访问。
 *
 * 一条通道 = 一个收款渠道实例：支付类型 + 收款码 + 金额规则 + 开关。
 * 下单时按 type/status 从这里挑一条可用的。
 *
 * EdgeOne 版把整张表存成一份数组文档（`ps`），读写都走租约锁；
 * 列表上的「收款笔数 / 收款金额」不再写在通道上，而是从订单摘要现算
 * （与 Cloudflare 版保持一致的口径：status 1/2 都算钱已到账）。
 */
import { now } from '../../lib/util';
import * as blob from '../../lib/blob-db';

/** 可写字段（顺序即表单字段顺序） */
export const PASSAGE_FIELDS = [
  'type',
  'code',
  'zf_pid',
  'ewm_type',
  'ewm',
  'status',
  'money_change',
  'pay_qf',
  'transfer',
  'hang_free',
  'remarks',
] as const;

/** 文本型字段（其余按数字存） */
const TEXT_FIELDS = new Set<string>(['zf_pid', 'ewm', 'remarks']);

export interface PassageListFilter {
  type?: number;
  code?: number;
  status?: number;
  /** 创建时间范围（unix 秒，含边界） */
  startTs?: number;
  endTs?: number;
  /** 支付用户ID（精确） */
  zfPid?: string;
  /** 备注（模糊） */
  remarks?: string;
  limit: number;
  offset: number;
}

export type PassageListRow = Record<string, unknown> & {
  id: number;
  type: number;
  code: number;
};

export async function list(
  f: PassageListFilter
): Promise<{ rows: PassageListRow[]; count: number }> {
  const r = await blob.listPassages(f);
  return { rows: r.rows as unknown as PassageListRow[], count: r.count };
}

export async function findById(id: number): Promise<Record<string, unknown> | null> {
  const p = await blob.getPassage(id);
  return (p as unknown as Record<string, unknown>) ?? null;
}

/** 表单参数 → 可写字段（文本 / 数字分别处理，未传的字段跳过） */
export function parseFields(p: Record<string, string>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of PASSAGE_FIELDS) {
    if (p[f] === undefined) continue;
    data[f] = TEXT_FIELDS.has(f) ? p[f] : Number(p[f]) || 0;
  }
  return data;
}

export async function insert(data: Record<string, unknown>): Promise<number> {
  return blob.insertPassage(data);
}

export async function update(id: number, data: Record<string, unknown>): Promise<void> {
  await blob.updatePassage(id, data);
}

export async function removeMany(idList: number[]): Promise<void> {
  await blob.removePassages(idList);
}

export async function setStatus(id: number, status: number): Promise<void> {
  await blob.updatePassage(id, { status });
}

/** 新增通道的时间戳（service 用，避免漏填） */
export function stamps(): { create_time: number; update_time: number } {
  const t = now();
  return { create_time: t, update_time: t };
}
