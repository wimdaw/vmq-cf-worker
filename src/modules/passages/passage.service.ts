/**
 * 通道业务：列表、保存、启停、删除。
 */
import { appSecret, getConfig, type Env } from '../../lib/db';
import { originOf } from '../../lib/util';
import type { ApiResult } from '../../http/respond';
import { fail, ok, table } from '../../http/respond';
import { filterVal, idsOf, intVal, pageArgs } from '../../http/request';
import { dayTs } from '../shared/format';
import * as repo from './passage.repository';
import { toListRow } from './passage.presenter';

export async function listPassages(
  env: Env,
  p: Record<string, string>,
  /** 当前请求的对外 origin（含协议）；config.url 没配时用它兜底 */
  reqOrigin = ''
): Promise<ApiResult> {
  const { limit, offset } = pageArgs(p);
  const num = (k: 'type' | 'code' | 'status'): number | undefined => {
    const v = filterVal(p, k);
    return v === '' ? undefined : Number(v);
  };

  const { rows, count } = await repo.list({
    type: num('type'),
    code: num('code'),
    status: num('status'),
    startTs: dayTs(filterVal(p, 'start')),
    endTs: dayTs(filterVal(p, 'end'), true),
    zfPid: filterVal(p, 'zf_pid') || undefined,
    remarks: filterVal(p, 'remarks') || undefined,
    limit,
    offset,
  });

  // APP 扫码 / 手动配置：监控端绑定要用「https://域名/通讯密钥/通道id,支付类型」
  // 只有管理员能调这个接口，字符串给前端展示是预期行为（与旧后台一致）
  const appBase = await appConfigBase(env, reqOrigin);
  // 域名或密钥缺一个，整串就没意义（App 拿到也绑不上），给空串让前端显示「—」
  return table(
    rows.map((r) => ({
      ...toListRow(r),
      app_config: appBase ? `${appBase}${r.id},${r.type}` : '',
    })),
    count
  );
}

/**
 * 监控端绑定串的前缀：「https://域名/密钥/」，后面接「通道id,支付类型」。
 *
 * 这一串同时供「APP扫码配置」（二维码内容）和「APP手动配置」（文本框）使用，
 * 所以只在这里拼一次，两种方式必然一致。
 *
 * 三条硬约束（错一条，App 就绑不上或者签不过）：
 *   1. **必须带 https://**：App 直接拿它当地址去请求 /appPush，缺协议就发不出去
 *   2. 域名取 config.url；没配就用当前请求的 origin 兜底
 *   3. 密钥必须与 /appPush 验签用的是同一个（appSecret：app_key → key → epaykey_ali），
 *      否则 App 拿扫到的值去签名，服务端验签必然失败
 */
async function appConfigBase(env: Env, fallbackOrigin = ''): Promise<string> {
  const origin = originOf((await getConfig(env, 'url')) || '') || originOf(fallbackOrigin);
  const key = await appSecret(env);
  return origin && key ? `${origin}/${key}/` : '';
}

/** 新增（id=0）或修改 */
export async function savePassage(
  env: Env,
  p: Record<string, string>,
  id: number
): Promise<ApiResult> {
  const data = repo.parseFields(p);
  if (data['type'] === undefined) return fail('请选择支付模式');
  if (!data['ewm']) return fail('请填写收款码');

  if (id) {
    data['update_time'] = Math.floor(Date.now() / 1000);
    await repo.update(id, data);
    return ok('保存成功');
  }

  const t = repo.stamps();
  await repo.insert({ ...data, create_time: t.create_time, update_time: t.update_time });
  return ok('添加成功');
}

export async function setPassageStatus(
  env: Env,
  p: Record<string, string>
): Promise<ApiResult> {
  const id = intVal(p, 'id');
  if (!id) return fail('缺少 id');
  await repo.setStatus(id, intVal(p, 'status'));
  return ok('设置成功');
}

export async function removePassages(env: Env, p: Record<string, string>): Promise<ApiResult> {
  const list = idsOf(p);
  if (!list.length) return fail('缺少 id');
  await repo.removeMany(list);
  return ok(`已删除 ${list.length} 条`);
}
