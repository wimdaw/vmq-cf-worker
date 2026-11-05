import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, QrCode, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyRow, PageHeader, Panel, Pagination, Toolbar } from '@/components/page-shell';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DateRangePicker } from '@/components/date-range-picker';
import { QrCodeField } from '@/components/qr-code-field';
import { AppConfigDialog } from '@/components/app-config-dialog';
import { api, ApiError } from '@/lib/api';

interface PassageRow {
  id: number;
  type: string;
  old_type: number;
  old_code: number;
  money_change: number;
  pay_qf: number;
  code: string;
  ewm_type: number;
  ewm: string;
  status: number;
  remarks: string;
  zf_pid: string;
  /** 累计收款笔数：由后端按 orders 实时聚合（status IN (1,2)） */
  succcount: number;
  /** 累计收款金额，已格式化成两位小数字符串 */
  succprice: string;
  create_time: string;
  app_config: string;
}

const PAY_TYPES = [
  { value: '1', label: '微信（wxpay）' },
  { value: '2', label: '支付宝（alipay）' },
  { value: '3', label: 'QQ（qqpay）' },
  { value: '4', label: '数字人民币（rmbpay）' },
];
const PAY_CODES = [
  { value: '0', label: '无金额收款码' },
  { value: '1', label: '有金额收款码' },
  { value: '2', label: '免输入' },
];

const LIMIT = 20;

/** 收款码要么是图片地址，要么是需要现场生成二维码的内容 */
function isImageUrl(v: string) {
  return /^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?|$)/i.test(v) || v.startsWith('data:');
}
function qrSrc(v: string) {
  return isImageUrl(v) ? v : `/enQrcode?url=${encodeURIComponent(v)}&size=10`;
}

interface FormState {
  id: number;
  type: string;
  code: string;
  zf_pid: string;
  ewm_type: string;
  ewm: string;
  remarks: string;
  status: string;
  money_change: string;
  pay_qf: string;
}

const EMPTY: FormState = {
  id: 0,
  type: '1',
  code: '0',
  zf_pid: '',
  ewm_type: '0',
  ewm: '',
  remarks: '',
  status: '1',
  money_change: '0',
  pay_qf: '0',
};

export function PassagesPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  // 与订单页一致：条件先填，点「搜索」才生效
  const EMPTY_FILTERS = {
    start: '', end: '', type: '', code: '', zf_pid: '', status: '', remarks: '',
  };
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState<number[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [appConfigOpen, setAppConfigOpen] = useState(false);
  // 收款码 / APP 配置的二维码预览：弹窗展示，不再新开页面
  const [qr, setQr] = useState<{ src: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; desc?: string; action?: () => Promise<void> }>({
    open: false,
    title: '',
  });

  const query = useQuery({
    queryKey: ['passages', page, filters],
    queryFn: async () => {
      const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      const r = await api.get<PassageRow[]>(`/passages?${qs.toString()}`);
      return { rows: r.data ?? [], count: r.count ?? 0 };
    },
  });

  const save = useMutation({
    mutationFn: (f: FormState) => {
      const body = {
        type: f.type,
        code: f.code,
        zf_pid: f.zf_pid,
        ewm_type: f.ewm_type,
        ewm: f.ewm,
        remarks: f.remarks,
        status: f.status,
        money_change: f.money_change,
        pay_qf: f.pay_qf,
      };
      return f.id ? api.put(`/passages/${f.id}`, body) : api.post('/passages', body);
    },
    onSuccess: (r) => {
      toast.success(r.msg || '已保存');
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['passages'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '保存失败'),
  });

  const toggle = useMutation({
    mutationFn: (v: { id: number; status: number }) =>
      api.patch(`/passages/${v.id}/status`, { status: v.status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['passages'] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: (ids: number[]) => api.del('/passages', { ids }),
    onSuccess: (r) => {
      toast.success(r.msg || '已删除');
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['passages'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '删除失败'),
  });

  const rows = query.data?.rows ?? [];
  const count = query.data?.count ?? 0;

  return (
    <>
      <PageHeader
        title="通道管理"
        description="一条通道 = 一个收款渠道实例；下单时按支付类型匹配"
        className="mb-4 border-b border-border pb-4"
      />

      {/* 搜索区：与旧后台一致 —— 项多，分两行展示 */}
      <div className="mb-3 space-y-3 border-b border-border pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-muted-foreground">时间范围</span>
          <DateRangePicker
            value={{ start: draft.start, end: draft.end }}
            onChange={(v) => setDraft((d) => ({ ...d, start: v.start, end: v.end }))}
          />
        </div>

        <Select value={draft.type || 'all'} onValueChange={(v) => setDraft((d) => ({ ...d, type: v === 'all' ? '' : v }))}>
          <SelectTrigger className="w-40 whitespace-nowrap">
            <SelectValue placeholder="支付模式" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部支付模式</SelectItem>
            {PAY_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={draft.code || 'all'} onValueChange={(v) => setDraft((d) => ({ ...d, code: v === 'all' ? '' : v }))}>
          <SelectTrigger className="w-40 whitespace-nowrap">
            <SelectValue placeholder="通道模式" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部通道模式</SelectItem>
            {PAY_CODES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-40"
          placeholder="支付用户ID"
          value={draft.zf_pid}
          onChange={(e) => setDraft((d) => ({ ...d, zf_pid: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(1);
              setFilters(draft);
            }
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={draft.status || 'all'} onValueChange={(v) => setDraft((d) => ({ ...d, status: v === 'all' ? '' : v }))}>
          <SelectTrigger className="w-36 whitespace-nowrap">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="1">开启</SelectItem>
            <SelectItem value="0">禁用</SelectItem>
          </SelectContent>
        </Select>

        <Input
          className="w-32"
          placeholder="备注"
          value={draft.remarks}
          onChange={(e) => setDraft((d) => ({ ...d, remarks: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(1);
              setFilters(draft);
            }
          }}
        />

        <Button
          onClick={() => {
            setPage(1);
            setFilters(draft);
          }}
        >
          <Search /> 搜索
        </Button>
      </div>
      </div>

      {/* 操作行 */}
      <Toolbar>
        <Button size="sm" onClick={() => setForm({ ...EMPTY })}>
          <Plus /> 新增通道
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setAppConfigOpen(true)}
        >
          <QrCode className="size-4" /> APP扫码配置
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void qc.invalidateQueries({ queryKey: ['passages'] })}
        >
          <RefreshCw className={query.isFetching ? 'animate-spin' : ''} /> 刷新
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!selected.length}
          title={selected.length ? undefined : '先在下方列表勾选要删除的通道'}
          onClick={() =>
            setConfirm({
              open: true,
              title: `批量删除 ${selected.length} 条通道？`,
              desc: '删除后这些通道不再参与下单。',
              action: async () => {
                await remove.mutateAsync(selected);
              },
            })
          }
        >
          <Trash2 /> 批量删除{selected.length ? ` (${selected.length})` : ''}
        </Button>
      </Toolbar>

      <Panel>
        <Table className="min-w-[1540px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.length === rows.length}
                  onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
                  aria-label="全选"
                />
              </TableHead>
              <TableHead className="w-14">ID</TableHead>
              <TableHead className="w-32">支付模式</TableHead>
              <TableHead className="w-32">通道模式</TableHead>
              <TableHead className="w-28">支付用户ID</TableHead>
              <TableHead className="w-24">收款码类型</TableHead>
              {/* APP 扫码配置紧跟在收款码类型之后：两者都是「这条通道怎么收款」的一部分 */}
              <TableHead className="w-24">APP扫码配置</TableHead>
              <TableHead className="w-24">无金额收款码</TableHead>
              <TableHead className="w-20 text-right">收款笔数</TableHead>
              <TableHead className="w-24 text-right">收款金额</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-36">添加时间</TableHead>
              <TableHead className="w-40">APP手动配置</TableHead>
              <TableHead className="w-32">备注</TableHead>
              <TableHead className="sticky right-0 z-10 w-36 border-b border-l border-border bg-card text-right shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.15)]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading ? (
              <EmptyRow colSpan={15} text="加载中…" />
            ) : query.error ? (
              <EmptyRow colSpan={15} text={`加载失败：${String(query.error)}`} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={15} text="还没有通道，点「新增通道」" />
            ) : (
              rows.map((r) => (
                <TableRow key={r.id} className="group">
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id)
                        )
                      }
                      aria-label={`选择通道 ${r.id}`}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{r.id}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.type}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{r.code}</TableCell>
                  <TableCell className="font-mono text-xs">{r.zf_pid || '—'}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {Number(r.ewm_type) === 1 ? '赞赏码' : '二维码'}
                  </TableCell>
                  <TableCell>
                    {r.app_config && Number(r.old_type) !== 3 ? (
                      <button
                        type="button"
                        onClick={() => setQr({ src: qrSrc(r.app_config), title: `通道 #${r.id} · APP扫码配置` })}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
                      >
                        <QrCode className="size-3.5" /> 查看
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.ewm ? (
                      <button
                        type="button"
                        onClick={() => setQr({ src: qrSrc(r.ewm), title: `通道 #${r.id} · 无金额收款码` })}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
                      >
                        <QrCode className="size-3.5" /> 查看
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.succcount}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.succprice}</TableCell>
                  <TableCell>
                    {r.status === 1 ? (
                      <Badge variant="success">开启</Badge>
                    ) : (
                      <Badge variant="muted">禁用</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {r.create_time || '—'}
                  </TableCell>
                  <TableCell>
                    {r.app_config && Number(r.old_type) !== 3 ? (
                      <div className="max-w-40 truncate font-mono text-xs" title={r.app_config}>
                        {r.app_config}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-32">
                    <div className="truncate text-xs" title={r.remarks}>
                      {r.remarks || '—'}
                    </div>
                  </TableCell>
                  <TableCell className="sticky right-0 z-10 border-l border-border bg-card text-right shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.15)] group-hover:bg-muted">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setForm(toForm(r))}>
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={toggle.isPending}
                        onClick={() =>
                          setConfirm({
                            open: true,
                            title: r.status === 1 ? '停用这条通道？' : '启用这条通道？',
                            desc:
                              r.status === 1
                                ? `通道 #${r.id}（${r.type}）停用后不再参与下单。`
                                : `通道 #${r.id}（${r.type}）启用后恢复参与下单。`,
                            action: async () => {
                              await toggle.mutateAsync({ id: r.id, status: r.status === 1 ? 0 : 1 });
                            },
                          })
                        }
                      >
                        {r.status === 1 ? '停用' : '启用'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        title="删除该通道"
                        disabled={remove.isPending}
                        onClick={() =>
                          setConfirm({
                            open: true,
                            title: '删除这条通道？',
                            desc: `通道 #${r.id}（${r.type}）将被删除，不再参与下单。`,
                            action: async () => {
                              await remove.mutateAsync([r.id]);
                            },
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <Pagination page={page} limit={LIMIT} count={count} onPage={setPage} />
      </Panel>

      {/* 新增 / 编辑 */}
      <Dialog open={!!form} onOpenChange={(v) => !v && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.id ? `编辑通道 #${form.id}` : '新增通道'}</DialogTitle>
          </DialogHeader>
          {form ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>
                    支付模式 <span className="text-destructive">*</span>
                  </Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAY_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>
                    通道模式 <span className="text-destructive">*</span>
                  </Label>
                  <Select value={form.code} onValueChange={(v) => setForm({ ...form, code: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAY_CODES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="zf_pid">支付用户ID</Label>
                <Input
                  id="zf_pid"
                  value={form.zf_pid}
                  placeholder="选填"
                  onChange={(e) => setForm({ ...form, zf_pid: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  支付宝填 UID（2088 开头），监控端绑定要用；数字人民币填钱包编码（优先使用收款码）。留空则按收款码内容识别。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>收款码类型</Label>
                <Select value={form.ewm_type} onValueChange={(v) => setForm({ ...form, ewm_type: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">二维码</SelectItem>
                    <SelectItem value="1">赞赏码</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  二维码存的是解码后的地址，支付页按订单金额现场生成图；赞赏码存的是图片本身，支付页直接展示。
                </p>
              </div>

              <QrCodeField
                id="ewm"
                label="无金额收款码"
                value={form.ewm}
                onChange={(v) => setForm({ ...form, ewm: v, ewm_type: '0' })}
                onImage={(url) => setForm({ ...form, ewm: url, ewm_type: '1' })}
                placeholder="上传图片自动解码，或直接粘贴 wxp://… / https://qr.alipay.com/…"
                hint={
                  <>
                    解码失败多半是图太糊或被压缩过，可到 cli.im/deqr 手动解码后粘贴；数字人民币请用「无限制时长」的收款码。
                  </>
                }
              />

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>付款需备注</Label>
                  <Select
                    value={form.money_change}
                    onValueChange={(v) => setForm({ ...form, money_change: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">不需要</SelectItem>
                      <SelectItem value="1">需要</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    开启后支付宝订单会在支付页提示用户备注订单号。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>区分方式</Label>
                  <Select value={form.pay_qf} onValueChange={(v) => setForm({ ...form, pay_qf: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">金额递增</SelectItem>
                      <SelectItem value="1">金额递减</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">同一金额被占用时，下一单加/减多少分。</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="remarks">备注</Label>
                  <Input
                    id="remarks"
                    placeholder="选填，仅后台可见"
                    value={form.remarks}
                    onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    状态 <span className="text-destructive">*</span>
                  </Label>
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">启用</SelectItem>
                      <SelectItem value="0">停用</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (!form || save.isPending) return;
                save.mutate(form);
              }}
              disabled={save.isPending}
            >
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 二维码预览弹窗 */}
      <Dialog open={!!qr} onOpenChange={(v) => !v && setQr(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{qr?.title}</DialogTitle>
          </DialogHeader>
          {qr ? (
            <img
              src={qr.src}
              alt={qr.title}
              className="mx-auto rounded-md border border-border bg-white p-2"
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm.open}
        title={confirm.title}
        description={confirm.desc}
        destructive
        busy={remove.isPending}
        onOpenChange={(v) => setConfirm((c) => ({ ...c, open: v }))}
        onConfirm={async () => {
          try {
            await confirm.action?.();
            setConfirm((c) => ({ ...c, open: false }));
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : '操作失败');
          }
        }}
      />

      <AppConfigDialog open={appConfigOpen} onOpenChange={setAppConfigOpen} />
    </>
  );
}

function toForm(r: PassageRow): FormState {
  return {
    id: r.id,
    type: String(r.old_type ?? 1),
    code: String(r.old_code ?? 0),
    zf_pid: r.zf_pid ?? '',
    ewm_type: String(r.ewm_type ?? 0),
    ewm: r.ewm ?? '',
    remarks: r.remarks ?? '',
    status: String(r.status ?? 1),
    money_change: String(r.money_change ?? 0),
    pay_qf: String(r.pay_qf ?? 0),
  };
}
