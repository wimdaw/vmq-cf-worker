/**
 * 内容类业务：快捷入口 / 公告 / 操作日志。
 */
import type { Env } from '../../lib/db';
import type { ApiResult } from '../../http/respond';
import { fail, ok, table } from '../../http/respond';
import { filterVal, idsOf, intVal, pageArgs, strVal } from '../../http/request';
import { withTimes } from '../shared/format';
import * as repo from './content.repository';

/* ============================ 操作日志 ============================ */

export async function listLogs(env: Env, p: Record<string, string>): Promise<ApiResult> {
  const { limit, offset } = pageArgs(p);
  const role = filterVal(p, 'role');
  const { rows, count } = await repo.listLogs({
    uid: role === '' ? undefined : Number(role),
    limit,
    offset,
  });
  return table(rows.map((r) => withTimes(r, ['create_time'])), count);
}

/**
 * 删除日志。
 *   { time: 7 } → 清理 7 天前（不带 id）
 *   带 id      → 批量删除指定行
 */
export async function removeLogs(env: Env, p: Record<string, string>): Promise<ApiResult> {
  if (p['time']) {
    const days = Number(p['time']) || 7;
    const n = await repo.removeLogsBefore(days);
    return ok(`已清理 ${n} 条`);
  }
  const list = idsOf(p);
  if (!list.length) return fail('缺少 id');
  await repo.removeLogs(list);
  return ok(`已删除 ${list.length} 条`);
}
