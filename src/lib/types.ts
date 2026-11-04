/** 领域类型与状态常量。
 *
 * 单独放一个文件是为了打断循环依赖：blob-db 需要这些类型，
 * 而 lib/db.ts 又要 re-export 给调用方。
 */

export interface OrderRow {
  id: number;
  order_id: string;
  out_trade_no: string;
  name: string;
  type: number;
  pid: number;
  passage_id: number;
  money: string;
  truemoney: string;
  pay_url: string;
  is_auto: number;
  notify_url: string;
  return_url: string;
  sitename: string;
  param: string;
  status: number;
  create_time: number;
  pay_time: number;
  close_time: number;
  notify_attempts: number;
  ip: string;
}

export interface PassageRow {
  id: number;
  type: number;
  code: number;
  zf_pid: string;
  ewm_type: number;
  ewm: string;
  balance: string;
  succcount: number;
  succprice: string;
  is_status: number;
  status: number;
  money_change: number;
  pay_qf: number;
  hang_free: number;
  cookie: string;
  remarks: string;
  create_time: number;
  update_time: number;
}

/** 管理员（整份存 `ad` 数组文档，password_hash 在内） */
export interface AdminDoc {
  id: number;
  username: string;
  password_hash: string;
  role: number;
  head_img: string;
  status: number;
  created_at: number;
  update_time: number;
  login_time: number;
}

/** 订单状态：与后台界面一致，不要改 */
export const STATUS = {
  PENDING: 0, // 待支付
  PAID: 1, // 已支付（回调成功）
  NOTIFY_FAILED: 2, // 已支付但回调失败
  EXPIRED: 3, // 已过期
} as const;

/** 钱已到账的状态（1 = 回调成功，2 = 回调失败但款已收到） */
export function isPaidStatus(status: number): boolean {
  return status === STATUS.PAID || status === STATUS.NOTIFY_FAILED;
}
