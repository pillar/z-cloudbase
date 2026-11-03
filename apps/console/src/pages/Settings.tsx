import { useState } from 'react';
import { Archive, Ban, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { defineMessages, useT } from '../i18n.tsx';
import { ErrorBanner, Section, StatusBadge, common, isOwner, useAction, useApp, useConfirm } from '../ui.tsx';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    general: '基本信息',
    generalDescription: '产品名称、可见性以及登录相关的地址白名单。',
    name: '名称',
    visibility: '可见性',
    visibilityOpen: '公开（任何人都可加入）',
    visibilityRestricted: '受限',
    redirectUris: '重定向 URI',
    redirectUrisHelp: '每行一个，会同步到所有环境。',
    allowedOrigins: '允许的来源',
    allowedOriginsHelp: '每行一个。',
    saveSettings: '保存设置',
    statusTitle: '产品状态',
    statusDescription: '停用或归档后，新的登录和基于密钥的调用会立即被拒绝。',
    currentStatus: '当前状态',
    activate: '启用',
    disable: '停用',
    archive: '归档',
    ownerOnly: '只有平台所有者可以修改产品状态。',
    confirmTitle: (id: string, status: string) => `将 ${id} 设为“${status}”？`,
    confirmBody: '新的登录和基于密钥的调用会立即被拒绝。',
    statusUpdated: '产品状态已更新',
  },
  en: {
    general: 'General',
    generalDescription: 'Product name, visibility and the sign-in address allow-lists.',
    name: 'Name',
    visibility: 'Visibility',
    visibilityOpen: 'Open (anyone can join)',
    visibilityRestricted: 'Restricted',
    redirectUris: 'Redirect URIs',
    redirectUrisHelp: 'One per line. Synced to every environment.',
    allowedOrigins: 'Allowed origins',
    allowedOriginsHelp: 'One per line.',
    saveSettings: 'Save settings',
    statusTitle: 'Product status',
    statusDescription: 'Once disabled or archived, new sign-ins and key-based calls are rejected immediately.',
    currentStatus: 'Current status',
    activate: 'Activate',
    disable: 'Disable',
    archive: 'Archive',
    ownerOnly: "Only a platform owner can change a product's status.",
    confirmTitle: (id: string, status: string) => `Set ${id} to ${status}?`,
    confirmBody: 'New sign-ins and key-based calls are rejected immediately.',
    statusUpdated: 'Product status updated',
  },
});

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function Settings({ product, reload }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const confirm = useConfirm();
  const [name, setName] = useState(product.name);
  const [visibility, setVisibility] = useState(product.visibility);
  const [redirects, setRedirects] = useState(product.redirect_uris.join('\n'));
  const [origins, setOrigins] = useState(product.allowed_origins.join('\n'));
  const save = useAction();
  const status = useAction();
  const path = `/products/${product.id}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await save.run(() => api.patch(path, { name, visibility, redirect_uris: lines(redirects), allowed_origins: lines(origins) }))) {
      toast.success(c.saved);
      reload();
    }
  }
  async function setStatus(next: 'active' | 'disabled' | 'archived') {
    if (next !== 'active') {
      const label = next === 'disabled' ? c.status_disabled : c.status_archived;
      if (!(await confirm({ title: t.confirmTitle(product.id, label), description: t.confirmBody, destructive: true }))) return;
    }
    if (await status.run(() => api.patch(path, { status: next }))) {
      toast.success(t.statusUpdated);
      reload();
    }
  }

  return (
    <div className="space-y-6">
      <Section title={t.general} description={t.generalDescription}>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="ps-name">{t.name}</Label>
              <Input id="ps-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ps-visibility">{t.visibility}</Label>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)}>
                <SelectTrigger id="ps-visibility" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">{t.visibilityOpen}</SelectItem>
                  <SelectItem value="restricted">{t.visibilityRestricted}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="ps-redirects">{t.redirectUris}</Label>
              <Textarea id="ps-redirects" rows={4} value={redirects} onChange={(e) => setRedirects(e.target.value)} />
              <p className="text-muted-foreground text-sm">{t.redirectUrisHelp}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ps-origins">{t.allowedOrigins}</Label>
              <Textarea id="ps-origins" rows={4} value={origins} onChange={(e) => setOrigins(e.target.value)} />
              <p className="text-muted-foreground text-sm">{t.allowedOriginsHelp}</p>
            </div>
          </div>
          <ErrorBanner message={save.error} />
          <div>
            <Button type="submit" disabled={save.busy}>
              {save.busy && <Loader2 className="animate-spin" />}
              {t.saveSettings}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t.statusTitle} description={t.statusDescription}>
        <div className="grid gap-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t.currentStatus}</span>
            <StatusBadge status={product.status} />
          </div>
          {isOwner(me) ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={status.busy || product.status === 'active'} onClick={() => setStatus('active')}>
                <CheckCircle2 />
                {t.activate}
              </Button>
              <Button variant="outline" disabled={status.busy || product.status === 'disabled'} onClick={() => setStatus('disabled')}>
                <Ban />
                {t.disable}
              </Button>
              <Button variant="destructive" disabled={status.busy || product.status === 'archived'} onClick={() => setStatus('archived')}>
                <Archive />
                {t.archive}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t.ownerOnly}</p>
          )}
          <ErrorBanner message={status.error} />
        </div>
      </Section>
    </div>
  );
}
