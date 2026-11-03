import { useState, type FormEvent } from 'react';
import { Loader2, MoreHorizontal, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  WEBHOOK_DESCRIPTION_MAX, WEBHOOK_EVENT_TYPES, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_ENDPOINTS_PER_ENV, WEBHOOK_SECRET_GRACE_S, WEBHOOK_URL_MAX,
  type Environment, type WebhookEventType,
} from '@z-cloudbase/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import type { CreatedWebhook, Webhook, WebhookAttempt, WebhookTestResult } from '../types.ts';
import {
  CopyText, EmptyState, EnvSelect, ErrorBanner, Loading, OneTimeSecret, Section, StatusBadge, common, hasRole, useAction, useApp, useConfirm, useLoad,
} from '../ui.tsx';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    title: 'Webhook 端点',
    description: (max: number) => `平台在用户事件发生时向这些地址发送 POST 请求。每个环境最多 ${max} 个端点。`,
    signing: (attempts: number) =>
      `请求按 Standard Webhooks 规范签名（webhook-id、webhook-timestamp、webhook-signature 请求头），可用 @z-cloudbase/server 的 verifyWebhook() 校验。非 2xx 响应会按退避策略重试，最多 ${attempts} 次（约 28 小时）。`,
    add: '添加端点',
    empty: '还没有 Webhook 端点',
    empty_hint: '添加一个端点，在用户加入、升级、删除或被封禁时收到通知。',
    col_url: '地址',
    col_events: '事件',
    col_status: '状态',
    col_created: '创建时间',
    grace: (time: string) => `旧密钥仍签名至 ${time}`,
    row_actions: '行操作',
    deliveries: '查看投递记录',
    send_test: '发送测试事件',
    edit: '编辑',
    enable: '启用',
    disable: '停用',
    rotate: '轮换签名密钥',
    create_title: '添加 Webhook 端点',
    edit_title: '编辑 Webhook 端点',
    form_desc: '必须使用 https；只有 dev 环境允许 http://localhost。不接受私有或回环 IP 地址。',
    url: '端点地址',
    desc_label: '描述（可选）',
    events_label: '订阅的事件',
    events_required: '至少选择一个事件。',
    enabled_label: '启用',
    ev_desc: (type: string) =>
      ({
        'user.joined': '用户首次登录此产品环境。',
        'user.upgraded': '游客账号绑定了第一种登录方式。',
        'user.deleted': '删除已完成（账号被删除，或用户退出产品且其产品数据已清理）。',
        'user.banned': '用户在全平台被封禁。',
        'user.unbanned': '用户的全平台封禁被解除（包括到期自动解除）。',
      })[type] ?? type,
    created: '端点已创建',
    updated: '端点已更新',
    secret_title: (url: string) => `${url} 的签名密钥`,
    disable_title: (url: string) => `停用 ${url}？`,
    disable_desc: '停用后不再投递新事件，队列中待投递和待重试的消息会被取消。',
    enabled_done: '端点已启用',
    disabled_done: '端点已停用',
    delete_title: (url: string) => `删除 ${url}？`,
    delete_desc: '端点及其投递记录会被删除，待投递的消息会被取消。此操作不可撤销。',
    deleted: '端点已删除',
    rotate_title: (url: string) => `轮换 ${url} 的签名密钥？`,
    rotate_desc: (hours: number) => `会生成新密钥。旧密钥在接下来的 ${hours} 小时内仍会附加签名，方便你更新接收端；之后只用新密钥签名。`,
    rotated: '签名密钥已轮换',
    test_ok: (code: string, ms: string) => `测试事件已送达：HTTP ${code}（${ms} ms）`,
    test_failed: (detail: string) => `测试事件投递失败：${detail}`,
    test_queued: '测试事件已加入队列',
    log_title: '投递记录',
    log_desc: (url: string) => `${url} 最近的投递尝试。`,
    pending: (n: string) => `${n} 条消息等待投递或重试`,
    close: '关闭',
    log_empty: '还没有投递记录',
    col_time: '时间',
    col_event: '事件',
    col_attempt: '第几次',
    col_code: '状态码',
    col_latency: '耗时',
    col_error: '错误',
    col_response: '响应片段',
    col_delivery: '投递状态',
  },
  en: {
    title: 'Webhook endpoints',
    description: (max: number) => `The platform POSTs to these URLs when user events happen. Up to ${max} endpoints per environment.`,
    signing: (attempts: number) =>
      `Requests are signed per the Standard Webhooks spec (webhook-id, webhook-timestamp, webhook-signature headers); verify them with verifyWebhook() from @z-cloudbase/server. Non-2xx responses are retried with backoff, up to ${attempts} attempts (about 28 hours).`,
    add: 'Add endpoint',
    empty: 'No webhook endpoints yet',
    empty_hint: 'Add one to be notified when users join, upgrade, are deleted or banned.',
    col_url: 'URL',
    col_events: 'Events',
    col_status: 'Status',
    col_created: 'Created',
    grace: (time: string) => `Previous secret still signs until ${time}`,
    row_actions: 'Row actions',
    deliveries: 'View deliveries',
    send_test: 'Send test event',
    edit: 'Edit',
    enable: 'Enable',
    disable: 'Disable',
    rotate: 'Rotate signing secret',
    create_title: 'Add webhook endpoint',
    edit_title: 'Edit webhook endpoint',
    form_desc: 'https is required; http://localhost is allowed in the dev environment only. Private and loopback IP addresses are refused.',
    url: 'Endpoint URL',
    desc_label: 'Description (optional)',
    events_label: 'Subscribed events',
    events_required: 'Select at least one event.',
    enabled_label: 'Enabled',
    ev_desc: (type: string) =>
      ({
        'user.joined': 'A user signed in to this product environment for the first time.',
        'user.upgraded': 'A guest account linked its first sign-in method.',
        'user.deleted': 'Deletion completed (account deleted, or the user left the product and their product data was cleaned up).',
        'user.banned': 'A platform-wide ban was applied to the user.',
        'user.unbanned': "The user's platform-wide ban was lifted (also when it expires).",
      })[type] ?? type,
    created: 'Endpoint created',
    updated: 'Endpoint updated',
    secret_title: (url: string) => `Signing secret for ${url}`,
    disable_title: (url: string) => `Disable ${url}?`,
    disable_desc: 'No new events are delivered, and queued deliveries and pending retries are cancelled.',
    enabled_done: 'Endpoint enabled',
    disabled_done: 'Endpoint disabled',
    delete_title: (url: string) => `Delete ${url}?`,
    delete_desc: 'The endpoint and its delivery log are deleted and pending deliveries are cancelled. This cannot be undone.',
    deleted: 'Endpoint deleted',
    rotate_title: (url: string) => `Rotate the signing secret of ${url}?`,
    rotate_desc: (hours: number) => `A new secret is generated. For the next ${hours} hours the old secret still adds a signature so you can update your receiver; after that only the new one signs.`,
    rotated: 'Signing secret rotated',
    test_ok: (code: string, ms: string) => `Test event delivered: HTTP ${code} (${ms} ms)`,
    test_failed: (detail: string) => `Test event failed: ${detail}`,
    test_queued: 'Test event queued',
    log_title: 'Delivery log',
    log_desc: (url: string) => `Recent delivery attempts to ${url}.`,
    pending: (n: string) => `${n} messages awaiting delivery or retry`,
    close: 'Close',
    log_empty: 'No deliveries yet',
    col_time: 'Time',
    col_event: 'Event',
    col_attempt: 'Attempt',
    col_code: 'Status code',
    col_latency: 'Latency',
    col_error: 'Error',
    col_response: 'Response snippet',
    col_delivery: 'Delivery',
  },
});

interface FormState {
  url: string;
  description: string;
  event_types: WebhookEventType[];
  enabled: boolean;
}

/** Create (`editing` null) or edit an endpoint; mounted while open. A created endpoint's secret is handed to `onSaved`. */
function WebhookDialog({ base, editing, onClose, onSaved }: {
  base: string; editing: Webhook | null; onClose: () => void; onSaved: (created?: CreatedWebhook) => void;
}) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const [form, setForm] = useState<FormState>(() =>
    editing
      ? { url: editing.url, description: editing.description ?? '', event_types: editing.event_types, enabled: editing.enabled }
      : { url: '', description: '', event_types: [...WEBHOOK_EVENT_TYPES], enabled: true },
  );
  const act = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    let created: CreatedWebhook | undefined;
    const ok = await act.run(async () => {
      if (editing) {
        await api.patch(`${base}/${editing.id}`, { url: form.url.trim(), description: form.description.trim() || null, event_types: form.event_types, enabled: form.enabled });
      } else {
        created = await api.post<CreatedWebhook>(base, {
          url: form.url.trim(), event_types: form.event_types, enabled: form.enabled, ...(form.description.trim() ? { description: form.description.trim() } : {}),
        });
      }
    });
    if (ok) {
      toast.success(editing ? t.updated : t.created);
      onSaved(created);
      onClose();
    }
  }
  const toggle = (type: WebhookEventType, on: boolean) =>
    setForm({ ...form, event_types: on ? WEBHOOK_EVENT_TYPES.filter((x) => x === type || form.event_types.includes(x)) : form.event_types.filter((x) => x !== type) });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{editing ? t.edit_title : t.create_title}</DialogTitle>
            <DialogDescription>{t.form_desc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wh-url">{t.url}</Label>
            <Input id="wh-url" required type="url" maxLength={WEBHOOK_URL_MAX} placeholder="https://example.com/webhooks" className="font-mono" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh-desc">{t.desc_label}</Label>
            <Input id="wh-desc" maxLength={WEBHOOK_DESCRIPTION_MAX} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t.events_label}</legend>
            {WEBHOOK_EVENT_TYPES.map((type) => (
              <div key={type} className="flex items-start gap-2">
                <Checkbox id={`wh-ev-${type}`} className="mt-0.5" checked={form.event_types.includes(type)} onCheckedChange={(v) => toggle(type, v === true)} />
                <div className="grid gap-0.5">
                  <Label htmlFor={`wh-ev-${type}`} className="font-mono text-xs">{type}</Label>
                  <p className="text-muted-foreground text-xs">{t.ev_desc(type)}</p>
                </div>
              </div>
            ))}
            {form.event_types.length === 0 && <p className="text-destructive text-sm">{t.events_required}</p>}
          </fieldset>
          <div className="flex items-center gap-2">
            <Checkbox id="wh-enabled" checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v === true })} />
            <Label htmlFor="wh-enabled" className="font-normal">{t.enabled_label}</Label>
          </div>
          <ErrorBanner message={act.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{c.cancel}</Button>
            <Button type="submit" disabled={act.busy || form.event_types.length === 0}>
              {act.busy && <Loader2 className="animate-spin" />}
              {editing ? c.save : c.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryLog({ base, webhook, onClose, tick }: { base: string; webhook: Webhook; onClose: () => void; tick: number }) {
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const log = useLoad(
    (a) => a.get<{ attempts: WebhookAttempt[]; pending: number }>(`${base}/${webhook.id}/deliveries`, { limit: 50 }),
    `${base}/${webhook.id}#${tick}`,
  );
  const codeBadge = (code: number | null) =>
    code === null ? '–' : <Badge variant={code >= 200 && code < 300 ? 'secondary' : 'destructive'} className="font-mono">{code}</Badge>;

  return (
    <Section
      title={t.log_title}
      description={
        <>
          {t.log_desc(webhook.url)}
          {log.data && log.data.pending > 0 && <> · {t.pending(f.number(log.data.pending))}</>}
        </>
      }
      action={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={log.loading} onClick={log.reload}>
            {log.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {c.refresh}
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label={t.close}>
            <X className="size-4" />
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={log.error} />
        <Loading loading={log.loading && !log.data} />
        {log.data && log.data.attempts.length === 0 && <EmptyState title={t.log_empty} />}
        {log.data && log.data.attempts.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.col_time}</TableHead>
                  <TableHead>{t.col_event}</TableHead>
                  <TableHead>{t.col_attempt}</TableHead>
                  <TableHead>{t.col_code}</TableHead>
                  <TableHead>{t.col_latency}</TableHead>
                  <TableHead>{t.col_error}</TableHead>
                  <TableHead>{t.col_response}</TableHead>
                  <TableHead>{t.col_delivery}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.data.attempts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap">{f.time(a.attempted_at)}</TableCell>
                    <TableCell><span className="font-mono text-xs">{a.event_type}</span></TableCell>
                    <TableCell>{a.attempt} / {WEBHOOK_MAX_ATTEMPTS}</TableCell>
                    <TableCell>{codeBadge(a.status_code)}</TableCell>
                    <TableCell className="whitespace-nowrap">{f.number(a.latency_ms)} ms</TableCell>
                    <TableCell className="max-w-48 truncate text-xs" title={a.error ?? undefined}>{a.error ?? '–'}</TableCell>
                    <TableCell className="max-w-64 truncate font-mono text-xs" title={a.response_snippet ?? undefined}>{a.response_snippet ?? '–'}</TableCell>
                    <TableCell>{a.delivery_status ? <StatusBadge status={a.delivery_status} /> : '–'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Section>
  );
}

export function Webhooks({ product }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const confirm = useConfirm();
  const envs = product.environments.map((e) => e.env);
  const [env, setEnv] = useState<Environment>(envs[0] ?? 'dev');
  const base = `/products/${product.id}/environments/${env}/webhooks`;
  const list = useLoad((a) => a.get<{ webhooks: Webhook[] }>(base), base);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [dialog, setDialog] = useState<{ editing: Webhook | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [logTick, setLogTick] = useState(0);
  const act = useAction();

  // Hint only (the server enforces RBAC): developers may change webhooks outside prod.
  const canWrite = hasRole(me, product.id, 'product_admin') || (env !== 'prod' && hasRole(me, product.id, 'product_developer'));
  const selectedHook = list.data?.webhooks.find((w) => w.id === selected) ?? null;

  function changeEnv(e: Environment) {
    setEnv(e);
    setSelected(null);
    setSecret(null);
  }
  async function setEnabled(w: Webhook, enabled: boolean) {
    if (!enabled && !(await confirm({ title: t.disable_title(w.url), description: t.disable_desc, confirmLabel: t.disable, destructive: true }))) return;
    if (await act.run(() => api.patch(`${base}/${w.id}`, { enabled }))) {
      toast.success(enabled ? t.enabled_done : t.disabled_done);
      list.reload();
      setLogTick((n) => n + 1);
    }
  }
  async function remove(w: Webhook) {
    if (!(await confirm({ title: t.delete_title(w.url), description: t.delete_desc, confirmLabel: c.delete, destructive: true }))) return;
    if (await act.run(() => api.delete(`${base}/${w.id}`))) {
      toast.success(t.deleted);
      if (selected === w.id) setSelected(null);
      list.reload();
    }
  }
  async function rotate(w: Webhook) {
    if (!(await confirm({ title: t.rotate_title(w.url), description: t.rotate_desc(WEBHOOK_SECRET_GRACE_S / 3600), confirmLabel: t.rotate }))) return;
    let res: { secret: string } | undefined;
    if (await act.run(async () => (res = await api.post<{ id: string; secret: string; previous_secret_expires_at: number }>(`${base}/${w.id}/rotate-secret`)))) {
      setSecret({ title: t.secret_title(w.url), value: res!.secret });
      toast.success(t.rotated);
      list.reload();
    }
  }
  async function sendTest(w: Webhook) {
    let res: WebhookTestResult | undefined;
    if (!(await act.run(async () => (res = await api.post<WebhookTestResult>(`${base}/${w.id}/test`))))) return;
    const a = res!.attempt;
    if (!a) toast.info(t.test_queued);
    else if (a.status_code !== null && a.status_code >= 200 && a.status_code < 300) toast.success(t.test_ok(String(a.status_code), f.number(a.latency_ms)));
    else toast.error(t.test_failed([a.status_code !== null ? `HTTP ${a.status_code}` : null, a.error].filter(Boolean).join(' · ') || '–'));
    setSelected(w.id);
    setLogTick((n) => n + 1);
  }

  const addButton = canWrite && (
    <Button size="sm" onClick={() => setDialog({ editing: null })}>
      <Plus />
      {t.add}
    </Button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <EnvSelect labelled value={env} onChange={changeEnv} envs={envs} />
      </div>

      {secret && <OneTimeSecret title={secret.title} value={secret.value} onDone={() => setSecret(null)} />}

      <Section title={t.title} description={t.description(WEBHOOK_MAX_ENDPOINTS_PER_ENV)} action={addButton}>
        <div className="space-y-4">
          <ErrorBanner message={list.error ?? act.error} />
          <Loading loading={list.loading && !list.data} />
          {list.data && list.data.webhooks.length === 0 && <EmptyState title={t.empty} description={t.empty_hint} action={addButton} />}
          {list.data && list.data.webhooks.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.col_url}</TableHead>
                    <TableHead>{t.col_events}</TableHead>
                    <TableHead>{t.col_status}</TableHead>
                    <TableHead>{t.col_created}</TableHead>
                    <TableHead className="w-10"><span className="sr-only">{c.actions}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.webhooks.map((w) => (
                    <TableRow key={w.id} data-state={w.id === selected ? 'selected' : undefined}>
                      <TableCell className="max-w-80">
                        <CopyText value={w.url} />
                        {w.description && <div className="text-muted-foreground mt-1 truncate text-xs">{w.description}</div>}
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-64 flex-wrap gap-1">
                          {w.event_types.map((e) => <Badge key={e} variant="secondary" className="font-mono text-xs font-normal">{e}</Badge>)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={w.enabled ? 'active' : 'disabled'} />
                        {w.previous_secret_expires_at && <div className="text-muted-foreground mt-1 text-xs whitespace-nowrap">{t.grace(f.time(w.previous_secret_expires_at))}</div>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(w.created_at)}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" disabled={act.busy} aria-label={t.row_actions}>
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setSelected(w.id)}>{t.deliveries}</DropdownMenuItem>
                            {canWrite && (
                              <>
                                <DropdownMenuItem disabled={!w.enabled} onSelect={() => sendTest(w)}>{t.send_test}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => setDialog({ editing: w })}>{t.edit}</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setEnabled(w, !w.enabled)}>{w.enabled ? t.disable : t.enable}</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => rotate(w)}>{t.rotate}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onSelect={() => remove(w)}>{c.delete}</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-muted-foreground text-sm">{t.signing(WEBHOOK_MAX_ATTEMPTS)}</p>
        </div>
      </Section>

      {selectedHook && <DeliveryLog base={base} webhook={selectedHook} tick={logTick} onClose={() => setSelected(null)} />}

      {canWrite && dialog && (
        <WebhookDialog
          key={dialog.editing?.id ?? 'new'}
          base={base}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onSaved={(created) => {
            if (created) setSecret({ title: t.secret_title(created.url), value: created.secret });
            list.reload();
          }}
        />
      )}
    </div>
  );
}
