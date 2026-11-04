import type { Env, OrderRow, PassageRow } from './db';
import { appSecret, getConfig } from './db';
import { verifyEpay } from './sign';
import { allocatePrice, fenToYuan, releasePrice, yuanToFen } from './amount';
import { nameToPayType } from './notify';
import { fmtYmdHms, now, randomInt } from './util';
import {
  findByOutTradeNo,
  getMonitor,
  getOrder as blobGetOrder,
  insertOrder as insertOrderDoc,
  listPassages,
} from './blob-db';

export interface CreateOrderResult {
  ok: boolean;
  msg: string;
  order?: OrderRow;
  payUrl?: string;
  isAuto?: number;
  passage?: PassageRow;
}

export async function getOrder(env: Env, orderId: string): Promise<OrderRow | null> {
  void env;
  return blobGetOrder(orderId);
}

/**
 * 下单。行为对齐 PHP 版 createOrder：
 *   验签 → 检查监控端在线 → 抢金额 → 选收款码 → 落库
 */
export async function createOrder(
  env: Env,
  params: Record<string, string>,
  ip: string
): Promise<CreateOrderResult> {
  const merchantKey = await appSecret(env);
  if (!merchantKey) return { ok: false, msg: '商户密钥未配置' };

  const outTradeNo = (params['out_trade_no'] ?? '').trim();
  if (!outTradeNo) return { ok: false, msg: '缺少商户订单号' };

  if (!verifyEpay(params, merchantKey)) return { ok: false, msg: '签名错误' };

  const type = nameToPayType(params['type'] ?? '');
  if (type === null) return { ok: false, msg: '支付方式错误' };

  const fen = yuanToFen((params['money'] ?? '').trim());
  if (fen === null || fen <= 0) return { ok: false, msg: '订单金额必须大于 0' };

  const requireOnline = (await getConfig(env, 'require_online', '1')) === '1';
  if (requireOnline) {
    const st = await getMonitor();
    if (!st.last_heart || now() - st.last_heart > 60) {
      return { ok: false, msg: '监控端状态异常，请检查' };
    }
  }

  // 这里先查一次是为了给出明确提示；真正的唯一性由 ou/ 的条件写兜底
  if (await findByOutTradeNo(outTradeNo)) return { ok: false, msg: '商户订单号已存在' };

  return insertOrder(env, {
    outTradeNo,
    type,
    fen,
    name: params['name'] ?? '',
    pid: Number.parseInt(params['pid'] ?? '1', 10) || 1,
    ip,
    notifyUrl: params['notify_url'] ?? '',
    returnUrl: params['return_url'] ?? '',
    sitename: params['sitename'] ?? '',
    param: params['param'] ?? '',
  });
}

/* ---------------- 落库（商户下单与示例页下单共用） ---------------- */

export interface NewOrder {
  outTradeNo: string;
  type: number;
  /** 订单金额（分） */
  fen: number;
  name: string;
  pid: number;
  ip: string;
  notifyUrl?: string;
  returnUrl?: string;
  sitename?: string;
  param?: string;
}

/** 抢金额 → 选收款码 → 写订单。前面的校验各入口自己负责 */
async function insertOrder(env: Env, o: NewOrder): Promise<CreateOrderResult> {
  const picked = await listPassages({ type: o.type, status: 1, limit: 1, offset: 0 });
  const passage = picked.rows[0];
  if (!passage) return { ok: false, msg: '暂无可用支付通道' };

  const ts = now();
  const orderId = `${fmtYmdHms(ts)}${randomInt(10)}${randomInt(10)}${randomInt(10)}${randomInt(10)}`;

  const realFen = await allocatePrice(env, o.fen, o.type, orderId);
  if (realFen === null) return { ok: false, msg: '订单超出负荷，请稍后重试' };

  const truemoney = fenToYuan(realFen);

  // 订单一律用通道自己的收款码，全部由监控端自动核对（is_auto 恒为 1）
  const payUrl = passage.ewm;
  const isAuto = 1;

  const written = await insertOrderDoc({
    orderId,
    outTradeNo: o.outTradeNo,
    name: o.name,
    type: o.type,
    pid: o.pid,
    passageId: passage.id,
    money: fenToYuan(o.fen),
    truemoney,
    payUrl,
    notifyUrl: o.notifyUrl,
    returnUrl: o.returnUrl,
    sitename: o.sitename,
    param: o.param,
    ip: o.ip,
    createTime: ts,
  });

  if (!written.ok) {
    await releasePrice(env, orderId);
    return { ok: false, msg: '商户订单号已存在' };
  }

  return { ok: true, msg: '成功', order: written.order, payUrl, isAuto, passage };
}

/* ---------------- 示例页下单 ---------------- */

/** 示例页固定商品名（旧版就是这个） */
export const DEMO_GOODS_NAME = '测试商品';

/**
 * 示例页（/demo）下单 —— 对应旧版 `/index/index/demo?type=&money=&out_trade_no=` 的真实行为：
 * **先落一笔订单，再跳到支付页出二维码**。
 *
 * 与商户下单（createOrder）的区别：
 *   - 不验签（公开页面，谁都能点）
 *   - 不带 notify_url / return_url，支付成功后不会触发任何回调
 *   - 商品名固定为「测试商品」，便于后台区分体验单
 */
export async function createDemoOrder(
  env: Env,
  typeRaw: string,
  moneyRaw: string,
  outTradeNoRaw: string,
  ip: string
): Promise<CreateOrderResult> {
  const type = nameToPayType(typeRaw);
  if (type === null) return { ok: false, msg: '支付方式错误' };

  const fen = yuanToFen((moneyRaw ?? '').trim());
  if (fen === null || fen <= 0) return { ok: false, msg: '订单金额必须大于 0' };

  const requireOnline = (await getConfig(env, 'require_online', '1')) === '1';
  if (requireOnline) {
    const st = await getMonitor();
    if (!st.last_heart || now() - st.last_heart > 60) {
      return { ok: false, msg: '监控端当前离线，无法体验（请先启动监控端 App）' };
    }
  }

  // 订单号：优先用页面生成的，缺了再自己造一个（长度与旧版一致）
  const ts = now();
  const outTradeNo =
    (outTradeNoRaw ?? '').trim() ||
    `${fmtYmdHms(ts)}${randomInt(10)}${randomInt(10)}${randomInt(10)}${randomInt(10)}${randomInt(10)}`;

  if (await findByOutTradeNo(outTradeNo)) {
    return { ok: false, msg: '体验订单号重复，请刷新页面重试' };
  }

  return insertOrder(env, {
    outTradeNo,
    type,
    fen,
    name: DEMO_GOODS_NAME,
    pid: 1,
    ip,
  });
}
