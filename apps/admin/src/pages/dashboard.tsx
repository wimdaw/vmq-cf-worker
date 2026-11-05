import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CreditCard,
  QrCode,
  ShoppingCart,
  Smartphone,
  Wallet,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AppConfigDialog } from '@/components/app-config-dialog';
import { api, type MonitorState, type Stats, type SystemInfo } from '@/lib/api';

/** 两列表格的一行：左标签右值 */
function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-border py-2 text-sm last:border-0">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all">{value}</span>
    </div>
  );
}

/**
 * 监控端状态的视觉规范。
 *
 * 三态用「图标 + 颜色 + 是否脉冲」三重区分，而不是只改文字颜色：
 *   在线  emerald + Wifi          + 外圈脉冲（心跳还在跳）
 *   异常  amber   + AlertTriangle （心跳断了但还在宽限期内，值得看一眼）
 *   离线  red     + WifiOff       （长时间没心跳，订单不会被自动核对）
 * 只靠颜色的话，色觉障碍用户和低亮度屏幕上很难分辨，所以图标形状也要能区分。
 */
const MONITOR_META: Record<
  MonitorState,
  { label: string; icon: typeof Wifi; badge: 'success' | 'warning' | 'danger'; dot: string; pulse: boolean }
> = {
  online: { label: '监控端在线', icon: Wifi, badge: 'success', dot: 'bg-emerald-500', pulse: true },
  degraded: { label: '监控端异常', icon: AlertTriangle, badge: 'warning', dot: 'bg-amber-500', pulse: false },
  offline: { label: '监控端离线', icon: WifiOff, badge: 'danger', dot: 'bg-red-500', pulse: false },
};

/** 老接口没有 monitorState 时按 online 布尔值退化，避免整页崩 */
function resolveState(state?: MonitorState, online?: boolean): MonitorState {
  return state ?? (online ? 'online' : 'offline');
}

/** 心跳年龄 → 人能读懂的话 */
function heartAgeText(age?: number): string {
  if (age === undefined || age < 0) return '从未收到心跳';
  if (age < 60) return `${age} 秒前心跳`;
  if (age < 3600) return `心跳中断 ${Math.floor(age / 60)} 分钟`;
  if (age < 86400) return `心跳中断 ${Math.floor(age / 3600)} 小时`;
  return `心跳中断 ${Math.floor(age / 86400)} 天`;
}

function MonitorBadge({ state, detail }: { state: MonitorState; detail?: string }) {
  const m = MONITOR_META[state];
  const Icon = m.icon;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={m.badge} className="gap-1.5 py-1">
        <span className="relative flex size-1.5">
          {m.pulse ? (
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${m.dot}`} />
          ) : null}
          <span className={`relative inline-flex size-1.5 rounded-full ${m.dot}`} />
        </span>
        <Icon className="size-3" />
        {m.label}
      </Badge>
      {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

/** 关于本项目：静态信息，写死在前端（不占接口） */
const ABOUT: Array<{ label: string; value: React.ReactNode }> = [
  { label: '项目名称', value: 'V免签 · 腾讯云 EdgeOne Pages 版' },
  {
    label: '仓库地址',
    value: (
      <a
        className="text-primary hover:underline"
        href="https://github.com/wimdaw/vmq-cf-worker"
        target="_blank"
        rel="noreferrer"
      >
        github.com/wimdaw/vmq-cf-worker (edgeone)
      </a>
    ),
  },
  { label: '开源协议', value: 'MIT' },
  {
    label: '运行架构',
    value: 'EdgeOne Cloud Functions (Node.js) + Blob 强一致存储',
  },
  { label: '免责声明', value: '仅供个人学习与自用，请勿用于商业用途' },
];

function Stat({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Wallet;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-medium tabular-nums">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <Icon className="size-4 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const [appConfigOpen, setAppConfigOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => (await api.get<Stats>('/stats')).data,
    refetchInterval: 15_000,
  });

  const info = useQuery({
    queryKey: ['system-info'],
    queryFn: async () => (await api.get<SystemInfo>('/system-info')).data,
    staleTime: 60_000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (error) return <p className="text-sm text-destructive">看板加载失败：{String(error)}</p>;
  if (!data) return null;

  // 日期、金额、订单数按索引配对；老接口没有 labels 时退化为空表
  const dailyIncome = (data.chartData.labels ?? []).map((day, i) => ({
    day,
    amount: data.chartData.income1[i] ?? 0,
    orders: data.chartData.order1[i] ?? 0,
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium">概览</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <MonitorBadge
              state={resolveState(data.monitorState, data.online)}
              detail={heartAgeText(data.heartAge)}
            />
            <span className="text-border">|</span>
            <span>每 15 秒自动刷新</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setAppConfigOpen(true)}
          >
            <QrCode className="size-3.5" /> APP扫码配置
          </Button>
          <a
            href="/"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            打开站点 <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="累计收入" value={`¥ ${data.income1}`} icon={Wallet} />
        <Stat label="今日收入" value={`¥ ${data.income2}`} icon={CreditCard} />
        <Stat label="累计订单" value={String(data.order1)} icon={ShoppingCart} />
        <Stat label="今日订单" value={String(data.order2)} icon={Activity} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>近 7 天收入</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">日期</TableHead>
                  <TableHead className="text-right">收入</TableHead>
                  <TableHead className="pr-5 text-right">订单数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dailyIncome.map(({ day, amount, orders }, i) => (
                  <TableRow key={day}>
                    <TableCell className="pl-5 tabular-nums text-muted-foreground">
                      {day}
                      {i === dailyIncome.length - 1 ? (
                        <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground">
                          今天
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      ¥ {amount.toFixed(2)}
                    </TableCell>
                    <TableCell className="pr-5 text-right tabular-nums text-muted-foreground">
                      {orders}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>订单状态</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['待支付', data.pending],
              ['已支付', data.paid],
              ['回调失败', data.notifyFailed],
              ['已过期', data.expired],
            ].map(([label, n]) => (
              <div key={String(label)} className="rounded-md bg-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-base font-medium tabular-nums">{n}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>系统信息</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-xs text-primary hover:bg-muted"
              onClick={() => setAppConfigOpen(true)}
            >
              <Smartphone className="size-3.5" /> APP扫码配置
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            {info.data ? (
              <>
                <InfoRow label="当前版本" value={info.data.edition} />
                <InfoRow label="站点地址" value={info.data.siteAddress || '—'} />
                <InfoRow label="运行平台" value={info.data.runPlatform} />
                <InfoRow label="数据库" value={info.data.database} />
                <InfoRow
                  label="监控端"
                  value={
                    <div className="flex flex-wrap items-center gap-2">
                      <MonitorBadge
                        state={resolveState(info.data.monitorState, info.data.monitorOnline)}
                        detail={info.data.monitor}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setAppConfigOpen(true)}
                      >
                        扫码绑定
                      </Button>
                    </div>
                  }
                />
                <InfoRow label="静态资源" value={info.data.staticAssets} />
                <InfoRow label="上传限制" value={info.data.uploadLimit} />
                <InfoRow label="回调判定" value={info.data.notifyJudge} />
                <InfoRow label="回调重试" value={info.data.notifyRetry} />
              </>
            ) : (
              <p className="py-4 text-sm text-muted-foreground">加载中…</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>关于本项目</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {ABOUT.map((row) => (
              <InfoRow key={row.label} label={row.label} value={row.value} />
            ))}
          </CardContent>
        </Card>
      </div>

      <AppConfigDialog open={appConfigOpen} onOpenChange={setAppConfigOpen} />
    </div>
  );
}
