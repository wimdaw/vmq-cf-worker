import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, QrCode, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface PassageRow {
  id: number;
  type: string;
  old_type: number;
  zf_pid: string;
  app_config: string;
  status: number;
}

export function AppConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'base' | number>('base');

  // 获取系统配置（读取通讯密钥和站点地址）
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: async () => (await api.get<{ config: Record<string, string>; defaults?: Record<string, string> }>('/config')).data,
    enabled: open,
  });

  // 获取通道列表
  const passagesQuery = useQuery({
    queryKey: ['passages-dialog'],
    queryFn: async () => {
      const res = await api.get<PassageRow[]>('/passages?page=1&limit=50');
      return res.data ?? [];
    },
    enabled: open,
  });

  const cfg = configQuery.data?.config ?? {};
  const defaults = configQuery.data?.defaults ?? {};
  const rawSiteUrl = cfg.url || defaults.epayurl_ali || window.location.origin;
  const siteUrl = rawSiteUrl.replace(/\/+$/, '');
  const commKey = cfg.key || '';

  // 基础绑定串：https://域名/密钥
  const baseConfig = siteUrl && commKey ? `${siteUrl}/${commKey}` : '';

  // 过滤通道（排除 QQ 钱包）
  const passages = (passagesQuery.data ?? []).filter((p) => p.old_type !== 3);

  // 当前选中的内容
  let currentContent = baseConfig;
  let currentLabel = '基础服务绑定（通知地址 + 通讯密钥）';

  if (activeTab !== 'base') {
    const selected = passages.find((p) => p.id === activeTab);
    if (selected?.app_config) {
      currentContent = selected.app_config;
      currentLabel = `通道 #${selected.id} · ${selected.type} (PID: ${selected.zf_pid || '无'})`;
    }
  }

  const qrSrc = currentContent
    ? `/enQrcode?url=${encodeURIComponent(currentContent)}&size=8`
    : '';

  function handleCopy() {
    if (!currentContent) return;
    navigator.clipboard
      .writeText(currentContent)
      .then(() => {
        setCopied(true);
        toast.success('配置内容已复制到剪贴板');
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        toast.error('复制失败，请手动选择复制');
      });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Smartphone className="size-5 text-primary" />
            APP 监控端扫码配置
          </DialogTitle>
          <DialogDescription className="text-xs">
            手机打开「V免签监控端」App → 切换至「配置」面板 → 点击「扫码配置」即可
          </DialogDescription>
        </DialogHeader>

        {/* 模式选择 Tab */}
        <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
          <Button
            size="sm"
            variant={activeTab === 'base' ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setActiveTab('base')}
          >
            基础服务绑定
          </Button>
          {passages.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={activeTab === p.id ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setActiveTab(p.id)}
            >
              #{p.id} {p.type}
            </Button>
          ))}
        </div>

        {/* 二维码区域 */}
        <div className="flex flex-col items-center justify-center py-2">
          {commKey ? (
            <>
              <div className="relative flex size-52 items-center justify-center rounded-xl border border-border bg-white p-2 shadow-sm">
                {qrSrc ? (
                  <img
                    src={qrSrc}
                    alt="APP扫码配置二维码"
                    className="size-full object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">生成二维码中…</span>
                )}
              </div>
              <p className="mt-2 text-xs font-medium text-foreground">{currentLabel}</p>
            </>
          ) : (
            <div className="flex h-44 w-full flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-4 text-center">
              <QrCode className="size-8 text-muted-foreground opacity-50" />
              <p className="mt-2 text-sm font-medium">尚未配置通讯密钥</p>
              <p className="mt-1 text-xs text-muted-foreground">
                请先前往「系统配置 → 密钥管理」生成或保存通讯密钥
              </p>
            </div>
          )}
        </div>

        {/* 文本内容与复制 */}
        {currentContent ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">二维码内容 / 手工录入</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs text-primary hover:bg-muted"
                onClick={handleCopy}
              >
                {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                {copied ? '已复制' : '复制内容'}
              </Button>
            </div>
            <div className="rounded-md border border-border bg-muted/50 p-2.5 font-mono text-xs break-all text-foreground select-all">
              {currentContent}
            </div>
          </div>
        ) : null}

        {/* 底部引导说明 */}
        <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">使用提示：</p>
          <p>1. 基础服务绑定会同时写入<strong>通知地址</strong>与<strong>通讯密钥</strong>；</p>
          <p>2. 如需快速绑定对应通道，可点击上方通道按钮切换至专属二维码；</p>
          <p>3. 无法使用相机时，可在 App 配置面板点击「手工配置」粘贴上述内容。</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
