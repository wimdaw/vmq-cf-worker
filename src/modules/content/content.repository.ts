/**
 * 内容类数据访问：操作日志（快捷入口 / 公告已随旧后台移除）。
 *
 * 日志 key 形如 `lg/<uid>/<时间戳>-<id>`：时间进 key，列表排序不用读内容；
 * uid 也进 key，按管理员筛选时只扫自己的前缀。
 */
import * as blob from '../../lib/blob-db';

export async function listLogs(filter: {
  uid?: number;
  limit: number;
  offset: number;
}): Promise<{ rows: Record<string, unknown>[]; count: number }> {
  const r = await blob.listLogs(filter);
  return { rows: r.rows as unknown as Record<string, unknown>[], count: r.count };
}

/** 写一条操作日志。失败不影响主流程（日志不是关键路径） */
export async function addLog(uid: number, content: string, ip: string): Promise<void> {
  try {
    await blob.addLog(uid, content, ip);
  } catch {
    /* 忽略 */
  }
}

export async function removeLogs(idList: number[]): Promise<void> {
  await blob.removeLogs(idList);
}

/** 清理 N 天前的日志，返回删除条数 */
export async function removeLogsBefore(days: number): Promise<number> {
  return blob.removeLogsBefore(days);
}
