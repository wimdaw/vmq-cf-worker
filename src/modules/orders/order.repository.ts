/**
 * 订单数据访问。
 *
 * 订单是收款系统的核心：金额匹配、回调状态、补单都读它。
 * EdgeOne 版没有 SQL（数据在 Blob 上，见 lib/blob-db.ts），这里保留原有函数签名，
 * 把原来的 SELECT/UPDATE 映射成文档操作；列表与统计都从「当月摘要」现算。
 */
import type { OrderRow } from '../../lib/db';
import {
  getOrderById,
  listOrders,
  removeOrders,
  countsByStatus,
  type OrderSummary,
} from '../../lib/blob-db';

export interface OrderListFilter {
  status?: number;
  /** 支付方式：1 微信 / 2 支付宝 / 3 QQ / 4 数字人民币 */
  type?: number;
  /** 创建时间范围（unix 秒，含边界） */
  startTs?: number;
  endTs?: number;
  keyword?: string;
  limit: number;
  offset: number;
}

export type OrderListRow = Pick<
  OrderSummary,
  | 'id'
  | 'pid'
  | 'order_id'
  | 'out_trade_no'
  | 'name'
  | 'type'
  | 'money'
  | 'truemoney'
  | 'status'
  | 'create_time'
  | 'pay_time'
  | 'notify_attempts'
>;

export async function list(
  f: OrderListFilter
): Promise<{ rows: OrderListRow[]; count: number }> {
  const r = await listOrders(f);
  const rows: OrderListRow[] = r.rows.map((x) => ({
    id: x.id,
    pid: x.pid,
    order_id: x.order_id,
    out_trade_no: x.out_trade_no,
    name: x.name,
    type: x.type,
    money: x.money,
    truemoney: x.truemoney,
    status: x.status,
    create_time: x.create_time,
    pay_time: x.pay_time,
    notify_attempts: x.notify_attempts,
  }));
  return { rows, count: r.count };
}

export async function findById(id: number): Promise<OrderRow | null> {
  return getOrderById(id);
}

export async function notifyAttempts(id: number): Promise<number> {
  const row = await getOrderById(id);
  return row?.notify_attempts ?? 0;
}

export async function removeMany(idList: number[]): Promise<number> {
  return removeOrders(idList);
}

/** 各状态订单数（看板用） */
export async function countByStatus(): Promise<Record<string, number>> {
  return countsByStatus();
}
