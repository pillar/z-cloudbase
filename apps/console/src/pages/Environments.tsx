import { useState } from 'react';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { SERVICE_SCOPES, type Environment } from '@z-cloudbase/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import {
  CopyText, EmptyState, EnvBadge, EnvSelect, ErrorBanner, Loading, OneTimeSecret, Section, StatusBadge, common, hasRole, useAction, useApp, useConfirm, useLoad,
} from '../ui.tsx';
import type { CreatedServiceKey, ServiceKey } from '../types.ts';
import type { TabProps } from './ProductDetail.tsx';
import { EnvSettings } from './EnvSettings.tsx';

const messages = defineMessages({
  zh: {
    envTitle: '环境',
    envDescription: '每个环境有独立的客户端 ID、可发布密钥和配额。',
    clientId: '客户端 ID',
    publishableKey: '可发布密钥',
    storageQuota: '存储配额',
    maxObject: '单个对象上限',
    rotate: '轮换',
    rotateTitle: (env: string) => `轮换 ${env} 的可发布密钥？`,
    rotateBody: '使用旧密钥的应用会立即失效。',
    rotated: '可发布密钥已轮换',
    publishableHint: '可发布密钥只用于标识产品和环境，不是机密。',
    keysTitle: '服务密钥',
    keysDescription: '供服务端调用平台 API 使用，按范围授权。密钥只在创建时显示一次。',
    label: '标签',
    scopes: '范围',
    created: '创建时间',
    lastUsed: '最近使用',
    status: '状态',
    noKeys: '还没有服务密钥',
    noKeysHint: '在下方创建一个，用于服务端上报日志或事件。',
    createKey: '创建服务密钥',
    createKeyDescription: '密钥的环境和范围创建后不可修改。',
    selectScopes: '至少选择一个范围。',
    newKeyTitle: (env: string) => `新的 ${env} 服务密钥`,
    keyCreated: '服务密钥已创建',
    revokeTitle: (name: string) => `撤销 ${name}？`,
    revokeBody: '该密钥会立即失效。',
    revoked: '服务密钥已撤销',
  },
  en: {
    envTitle: 'Environments',
    envDescription: 'Each environment has its own client ID, publishable key and quotas.',
    clientId: 'Client ID',
    publishableKey: 'Publishable key',
    storageQuota: 'Storage quota',
    maxObject: 'Max object size',
    rotate: 'Rotate',
    rotateTitle: (env: string) => `Rotate the ${env} publishable key?`,
    rotateBody: 'Apps using the old key stop working immediately.',
    rotated: 'Publishable key rotated',
    publishableHint: 'Publishable keys only identify the product and environment; they are not secrets.',
    keysTitle: 'Service keys',
    keysDescription: 'For server-side calls to the platform API, granted by scope. A key is shown only once, when created.',
    label: 'Label',
    scopes: 'Scopes',
    created: 'Created',
    lastUsed: 'Last used',
    status: 'Status',
    noKeys: 'No service keys yet',
    noKeysHint: 'Create one below to report logs or events from your servers.',
    createKey: 'Create service key',
    createKeyDescription: "A key's environment and scopes cannot be changed after creation.",
    selectScopes: 'Select at least one scope.',
    newKeyTitle: (env: string) => `New ${env} service key`,
    keyCreated: 'Service key created',
    revokeTitle: (name: string) => `Revoke ${name}?`,
    revokeBody: 'The key stops working immediately.',
    revoked: 'Service key revoked',
  },
});

export function Environments({ product, reload }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const confirm = useConfirm();
  const keys = useLoad((a) => a.get<{ keys: ServiceKey[] }>(`/products/${product.id}/service-keys`), product.id);
  const [pk, setPk] = useState<Record<string, string>>({});
  // One-time secret: held in component state only, cleared when dismissed or when leaving the tab.
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [form, setForm] = useState<{ env: Environment; scopes: string[]; label: string }>({ env: 'dev', scopes: ['logs:write'], label: '' });
  const create = useAction();
  const rotate = useAction();
  const revoke = useAction();

  // Hint only: developers never manage prod keys (the server refuses regardless).
  const canKeys = (env: Environment) => hasRole(me, product.id, 'product_admin') || (env !== 'prod' && hasRole(me, product.id, 'product_developer'));

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    let created: CreatedServiceKey | undefined;
    const ok = await create.run(async () => {
      created = await api.post<CreatedServiceKey>(`/products/${product.id}/service-keys`, { env: form.env, scopes: form.scopes, ...(form.label ? { label: form.label } : {}) });
    });
    if (ok && created) {
      setSecret({ title: t.newKeyTitle(created.env), value: created.key });
      toast.success(t.keyCreated);
      keys.reload();
    }
  }
  async function rotatePk(env: Environment) {
    if (!(await confirm({ title: t.rotateTitle(env), description: t.rotateBody, destructive: true, confirmLabel: t.rotate }))) return;
    let key = '';
    if (await rotate.run(async () => (key = (await api.post<{ publishable_key: string }>(`/products/${product.id}/environments/${env}/publishable-key/rotate`)).publishable_key))) {
      setPk((p) => ({ ...p, [env]: key }));
      toast.success(t.rotated);
    }
  }
  async function revokeKey(k: ServiceKey) {
    if (!(await confirm({ title: t.revokeTitle(k.label ?? k.id), description: t.revokeBody, destructive: true, confirmLabel: c.revoke }))) return;
    if (await revoke.run(() => api.delete(`/products/${product.id}/service-keys/${k.id}`))) {
      toast.success(t.revoked);
      keys.reload();
    }
  }

  return (
    <div className="space-y-6">
      {secret && <OneTimeSecret title={secret.title} value={secret.value} onDone={() => setSecret(null)} />}

      <Section title={t.envTitle} description={t.envDescription}>
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{c.environment}</TableHead>
                  <TableHead>{t.clientId}</TableHead>
                  <TableHead>{t.publishableKey}</TableHead>
                  <TableHead>{t.storageQuota}</TableHead>
                  <TableHead>{t.maxObject}</TableHead>
                  <TableHead className="w-px"><span className="sr-only">{c.actions}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.environments.map((e) => (
                  <TableRow key={e.env}>
                    <TableCell><EnvBadge env={e.env} /></TableCell>
                    <TableCell><CopyText value={e.id} /></TableCell>
                    <TableCell><CopyText value={pk[e.env] ?? e.publishable_key} /></TableCell>
                    <TableCell className="whitespace-nowrap">{f.bytes(e.storage_quota_bytes)}</TableCell>
                    <TableCell className="whitespace-nowrap">{f.bytes(e.max_object_bytes)}</TableCell>
                    <TableCell className="text-right">
                      {canKeys(e.env) && (
                        <Button variant="outline" size="sm" disabled={rotate.busy} onClick={() => rotatePk(e.env)}>
                          {rotate.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                          {t.rotate}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-sm">{t.publishableHint}</p>
          <ErrorBanner message={rotate.error} />
        </div>
      </Section>

      <EnvSettings product={product} reload={reload} />

      <Section title={t.keysTitle} description={t.keysDescription}>
        <div className="space-y-6">
          <ErrorBanner message={keys.error ?? revoke.error} />
          <Loading loading={keys.loading} />
          {keys.data && keys.data.keys.length === 0 && <EmptyState title={t.noKeys} description={t.noKeysHint} />}
          {keys.data && keys.data.keys.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{c.environment}</TableHead>
                    <TableHead>{t.label}</TableHead>
                    <TableHead>{t.scopes}</TableHead>
                    <TableHead>{t.created}</TableHead>
                    <TableHead>{t.lastUsed}</TableHead>
                    <TableHead>{t.status}</TableHead>
                    <TableHead className="w-px"><span className="sr-only">{c.actions}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.data.keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell><EnvBadge env={k.env} /></TableCell>
                      <TableCell>{k.label ?? '–'}</TableCell>
                      <TableCell><span className="font-mono text-xs">{k.scopes.join(', ')}</span></TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(k.created_at)}</TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(k.last_used_at)}</TableCell>
                      <TableCell><StatusBadge status={k.revoked_at ? 'revoked' : 'active'} /></TableCell>
                      <TableCell className="text-right">
                        {!k.revoked_at && canKeys(k.env) && (
                          <Button variant="outline" size="sm" className="text-destructive" disabled={revoke.busy} onClick={() => revokeKey(k)}>
                            {c.revoke}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <Separator />

          <form onSubmit={createKey} className="grid gap-4">
            <div>
              <h3 className="font-medium">{t.createKey}</h3>
              <p className="text-muted-foreground text-sm">{t.createKeyDescription}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>{c.environment}</Label>
                <EnvSelect value={form.env} onChange={(env) => setForm({ ...form, env })} envs={product.environments.map((e) => e.env).filter(canKeys)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sk-label">{t.label}</Label>
                <Input id="sk-label" maxLength={100} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </div>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">{t.scopes}</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SERVICE_SCOPES.map((s) => (
                  <div key={s} className="flex items-center gap-2">
                    <Checkbox
                      id={`sk-scope-${s}`}
                      checked={form.scopes.includes(s)}
                      onCheckedChange={(checked) => setForm({ ...form, scopes: checked === true ? [...form.scopes, s] : form.scopes.filter((x) => x !== s) })}
                    />
                    <Label htmlFor={`sk-scope-${s}`} className="font-mono text-xs font-normal">{s}</Label>
                  </div>
                ))}
              </div>
              {form.scopes.length === 0 && <p className="text-muted-foreground text-sm">{t.selectScopes}</p>}
            </fieldset>
            <ErrorBanner message={create.error} />
            <div>
              <Button type="submit" disabled={create.busy || form.scopes.length === 0}>
                {create.busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
                {t.createKey}
              </Button>
            </div>
          </form>
        </div>
      </Section>
    </div>
  );
}
