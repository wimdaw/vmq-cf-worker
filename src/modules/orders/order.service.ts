/**
 * 订单业务：列表、补单、删除。
 *
 * 服务层返回统一的 ApiResult（{code,msg,data,count}）——
 * 这正是接口契约本身，路由层只负责序列化，不再二次拼装。
 */
import type { Env } from '../../lib/db';
import { STATUS } from '../../lib/db';
import { deliverTask, enqueueNotify } from '../../lib/notify';
import type { ApiResult } from '../../http/respond';
import { fail, ok, table } from '../../http/respond';
import { filterVal, idsOf, intVal, pageArgs } from '../../http/request';
import { dayTs } from '../shared/format';
import * as repo from './order.repository';
import { toListRow } from './order.presenter';

/** 订单列表（兼容旧版 search[status] / search[keyword] 参数） */
export async function listOrders(env: Env, p: Record<string, string>): Promise<ApiResult> {
  const status = filterVal(p, 'status');
  const keyword = filterVal(p, 'keyword') || filterVal(p, 'search');
  const type = filterVal(p, 'type');
  const { limit, offset } = pageArgs(p);

  const { rows, count } = await repo.list({
    status: status === '' ? undefined : Number(status),
    type: type === '' ? undefined : Number(type),
    startTs: dayTs(filterVal(p, 'start')),
    endTs: dayTs(filterVal(p, 'end'), true),
    keyword: keyword || undefined,
    limit,
    offset,
  });

  return table(rows.map(toListRow), count);
}

/**
 * 补单：重新入队并立刻投递一次回调。
 *
 * 只对「已支付」的订单有意义 —— 待支付的订单钱还没到，
 * 补单会误导商户以为收款成功。
 */
export async function setBd(env: Env, p: Record<string, string>): Promise<ApiResult> {
  const id = intVal(p, 'id');
  const order = await repo.findById(id);
  if (!order) return fail('订单不存在');
  if (order.status === STATUS.PENDING) return fail('该订单还未支付，不能补单');
  if (!order.notify_url) return fail('该订单没有回调地址');

  const taskId = await enqueueNotify(env, order);
  await deliverTask(env, taskId);
  const attempts = await repo.notifyAttempts(id);
  return ok(`已重新通知（累计尝试 ${attempts} 次）`);
}

/** 批量删除订单 */
export async function removeOrders(env: Env, p: Record<string, string>): Promise<ApiResult> {
  const list = idsOf(p);
  if (!list.length) return fail('缺少 id');
  const n = await repo.removeMany(list);
  return ok(`已删除 ${n} 条`);
}
