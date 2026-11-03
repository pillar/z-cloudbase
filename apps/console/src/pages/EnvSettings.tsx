import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ENVIRONMENTS, UNKNOWN_EVENT_POLICIES, type Environment } from '@z-cloudbase/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { defineMessages, useT } from '../i18n.tsx';
import { EnvSelect, ErrorBanner, Section, common, hasRole, useAction, useApp } from '../ui.tsx';
import { buildEnvUpdate, formFromEnv, type EnvForm } from '../envSettings.ts';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    title: '环境设置',
    description: '按环境配置存储配额、上传限制和事件策略。',
    storageQuota: '存储配额（MB）',
    maxObject: '单个对象上限（MB）',
    dailyUpload: '每日上传配额（MB，按 UTC 日）',
    mimeTypes: '允许的 MIME 类型',
    extensions: '允许的扩展名',
    emptyAny: '留空表示不限制。',
    unknownEvents: '未知事件（prod）',
    unknownEventsHelp: '收到未注册的事件名时的处理方式。',
    policy_accept: 'accept · 接受并记录',
    policy_reject: 'reject · 拒绝',
    saveSettings: '保存设置',
    readOnly: '只有产品管理员可以修改环境设置。',
  },
  en: {
    title: 'Environment settings',
    description: 'Per-environment storage quotas, upload limits and event policy.',
    storageQuota: 'Storage quota (MB)',
    maxObject: 'Max object size (MB)',
    dailyUpload: 'Daily upload quota (MB, per UTC day)',
    mimeTypes: 'Allowed MIME types',
    extensions: 'Allowed extensions',
    emptyAny: 'Leave empty to allow any.',
    unknownEvents: 'Unknown events (prod)',
    unknownEventsHelp: 'How events with an unregistered name are handled.',
    policy_accept: 'accept · store them',
    policy_reject: 'reject · refuse them',
    saveSettings: 'Save settings',
    readOnly: 'Only a product admin can change environment settings.',
  },
});

export function EnvSettings({ product, reload }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const [env, setEnv] = useState<Environment>(ENVIRONMENTS[0]);
  const current = product.environments.find((e) => e.env === env);
  // key resets the form when switching environment or after a save reloads the product
  return (
    <Section title={t.title} description={t.description} action={<EnvSelect value={env} onChange={setEnv} />}>
      {current && (
        <SettingsForm
          key={`${env}:${JSON.stringify(current)}`}
          initial={formFromEnv(current)}
          canWrite={hasRole(me, product.id, 'product_admin')}
          save={async (body) => {
            await api.patch(`/products/${product.id}/environments/${env}`, body);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function SettingsForm({ initial, canWrite, save }: { initial: EnvForm; canWrite: boolean; save: (body: unknown) => Promise<void> }) {
  const t = useT(messages);
  const c = useT(common);
  const [f, setF] = useState(initial);
  const [formError, setFormError] = useState<string>();
  const action = useAction();
  const set = <K extends keyof EnvForm>(k: K, v: EnvForm[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const built = buildEnvUpdate(f);
    setFormError(built.ok ? undefined : built.error);
    if (built.ok && (await action.run(() => save(built.value)))) toast.success(c.saved);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <fieldset disabled={!canWrite} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="es-quota">{t.storageQuota}</Label>
            <Input id="es-quota" type="number" min={1} step="any" required value={f.storageQuotaMb} onChange={(e) => set('storageQuotaMb', e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="es-max">{t.maxObject}</Label>
            <Input id="es-max" type="number" min={1} step="any" required value={f.maxObjectMb} onChange={(e) => set('maxObjectMb', e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="es-daily">{t.dailyUpload}</Label>
            <Input id="es-daily" type="number" min={1} step="any" required value={f.dailyUploadMb} onChange={(e) => set('dailyUploadMb', e.target.value)} />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="es-mime">{t.mimeTypes}</Label>
            <Textarea id="es-mime" rows={2} placeholder="image/*, application/pdf" value={f.mimeTypes} onChange={(e) => set('mimeTypes', e.target.value)} />
            <p className="text-muted-foreground text-sm">{t.emptyAny}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="es-ext">{t.extensions}</Label>
            <Textarea id="es-ext" rows={2} placeholder="png, jpg, pdf" value={f.extensions} onChange={(e) => set('extensions', e.target.value)} />
            <p className="text-muted-foreground text-sm">{t.emptyAny}</p>
          </div>
        </div>
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="es-policy">{t.unknownEvents}</Label>
          <Select value={f.unknownEventPolicy} onValueChange={(v) => set('unknownEventPolicy', v as EnvForm['unknownEventPolicy'])}>
            <SelectTrigger id="es-policy" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNKNOWN_EVENT_POLICIES.map((p) => (
                <SelectItem key={p} value={p}>{t[`policy_${p}`]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-sm">{t.unknownEventsHelp}</p>
        </div>
      </fieldset>
      <ErrorBanner message={formError ?? action.error} />
      {canWrite ? (
        <div>
          <Button type="submit" disabled={action.busy}>
            {action.busy && <Loader2 className="animate-spin" />}
            {t.saveSettings}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t.readOnly}</p>
      )}
    </form>
  );
}
