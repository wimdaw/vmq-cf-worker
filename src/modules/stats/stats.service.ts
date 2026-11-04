/**
 * 统计业务：后台看板数据 + 首页卡片用的汇总。
 */
import type { Env } from '../../lib/db';
import { now } from '../../lib/util';
import type { ApiResult } from '../../http/respond';
import { okData } from '../../http/respond';
import { countByStatus } from '../orders/order.repository';
import * as repo from './stats.repository';

const DAYS = 7;
/** 监控端 60 秒内有心跳算在线（与订单的 require_online 判定同一个口径） */
export const ONLINE_WINDOW = 60;
/**
 * 心跳中断多久算「异常」。
 *
 * 监控端每 30 秒左右上报一次，所以超过 ONLINE_WINDOW 就说明至少漏了一拍。
 * 但一漏就报「离线」噪音太大（网络抖动、切后台一下都会漏），所以再给一个
 * 宽限窗口：60s ~ 10min 之间算「异常」（还能救，去看看吧），
 * 超过 10 分钟才判「离线」（基本可以确认监控端没在跑了）。
 */
export const DEGRADED_WINDOW = 600;

export type MonitorState = 'online' | 'degraded' | 'offline';

/**
 * 心跳年龄（秒，-1 表示从未上报）→ 监控端状态。
 *
 * 放在后端算而不是前端各算一遍：概览页顶部徽标和「系统信息」里的监控端行
 * 用的是两个不同接口，阈值若在前端重复实现，改一处忘一处就会出现
 * 「上面显示在线、下面显示离线」的自相矛盾。
 */
export function monitorStateOf(age: number): MonitorState {
  if (age < 0) return 'offline';
  if (age <= ONLINE_WINDOW) return 'online';
  if (age <= DEGRADED_WINDOW) return 'degraded';
  return 'offline';
}

/**
 * 看板数据。
 * 契约来自 welcome.html 里的 JS：
 *   { code:1, data:{ income1, income2, order1, order2,
 *                    chartData:{ income1:[7], income2:[7], order1:[7], order2:[7] } } }
 * income1/order1 = 当日值，income2/order2 = 累计值，chartData 是最新 7 天曲线。
 */
export async function dashboard(env: Env): Promise<ApiResult> {
  const ts = now();
  const total = await repo.paidTotals();
  const today = await repo.paidSince(repo.dayStart(ts));
  const byDay = await repo.dailyPaid(repo.dayStart(ts, DAYS - 1));

  const chartData = {
    labels: [] as string[],
    income1: [] as number[],
    income2: [] as number[],
    order1: [] as number[],
    order2: [] as number[],
  };

  const cumIncome = total.s;
  const cumOrder = total.c;
  const days = Array.from({ length: DAYS }, (_, i) => repo.dayStart(ts, DAYS - 1 - i));

  for (let i = 0; i < DAYS; i++) {
    const key = repo.dayKey(days[i]!);
    const v = byDay.get(key) ?? { c: 0, s: 0 };
    chartData.labels.push(repo.dayLabel(days[i]!));
    chartData.income1.push(Number(v.s.toFixed(2)));
    chartData.order1.push(v.c);

    // 累计曲线：总数减去"之后几天"的量
    let laterIncome = 0;
    let laterOrder = 0;
    for (let j = i + 1; j < DAYS; j++) {
      const w = byDay.get(repo.dayKey(days[j]!)) ?? { c: 0, s: 0 };
      laterIncome += w.s;
      laterOrder += w.c;
    }
    chartData.income2.push(Number((cumIncome - laterIncome).toFixed(2)));
    chartData.order2.push(cumOrder - laterOrder);
  }

  const heart = await repo.lastHeart();
  const counts = await countByStatus();
  const heartAge = heart ? ts - heart : -1;
  const state = monitorStateOf(heartAge);

  return okData(
    {
      income1: total.s.toFixed(2),
      income2: today.s.toFixed(2),
      order1: total.c,
      order2: today.c,
      chartData,
      // 下面几个是额外给的，方便 /api/stats 与调试
      online: state === 'online',
      // 心跳年龄与三态：前端据 monitorState 上色，据 heartAge 文案里显示「多久没心跳」
      heartAge,
      monitorState: state,
      pending: counts['0'] ?? 0,
      paid: counts['1'] ?? 0,
      notifyFailed: counts['2'] ?? 0,
      expired: counts['3'] ?? 0,
    },
    ''
  );
}

export interface Overview {
  counts: Record<string, number>;
  todayPaid: { c: number; s: number };
  allPaid: { c: number; s: number };
  lastHeart: number;
}

/** 首页要的那几个数（渲染层负责编文案） */
export async function overview(env: Env): Promise<Overview> {
  const ts = now();
  const [counts, todayPaid, allPaid, lastHeart] = await Promise.all([
    countByStatus(),
    repo.paidSince(repo.dayStart(ts)),
    repo.paidTotals(),
    repo.lastHeart(),
  ]);
  return { counts, todayPaid, allPaid, lastHeart };
}
