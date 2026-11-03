import { useState, type FormEvent } from 'react';
import { Ban, Download, ExternalLink, Loader2, MoreHorizontal, Search, ShieldAlert, ShieldOff, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import {
  BAN_REASON_MAX, IMPERSONATION_MAX_S, IMPERSONATION_REASON_MAX, IMPERSONATION_REASON_MIN, IMPERSONATION_REQUEST_TTL_S, USER_EXPORT_PAGE_ROWS, type Environment,
} from '@z-cloudbase/contracts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiRequestError } from '../api.ts';
import { readConfig } from '../config.ts';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import type { Impersonation, MembershipRow, UserLookup } from '../types.ts';
import {
  CopyText, EmptyState, EnvSelect, ErrorBanner, Loading, Section, StatusBadge, common, hasRole, isOwner, useAction, useApp, useConfirm, useLoad,
} from '../ui.tsx';
import { useProductEnv } from '../productEnv.tsx';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    find_title: '查找用户',
    find_desc: '按用户 ID 或完整邮箱精确查找。查询会被记入审计日志。',
    find_placeholder: 'usr_… 或完整邮箱',
    find_button: '查找',
    verified: '邮箱已验证',
    unverified: '邮箱未验证',
    anonymous: '匿名用户',
    scope_hint: '只显示你有权管理的产品中的成员关系。',
    col_product: '产品',
    col_user: '用户',
    col_status: '状态',
    col_joined: '加入时间',
    col_last_seen: '最近活跃',
    deletion_title: '删除 / 导出请求',
    deletion_none: '没有相关请求。',
    deletion_line: (kind: string, scope: string) => `${kind}（${scope}）`,
    deletion_dates: (requested: string, due: string) => `申请于 ${requested}，截止 ${due}`,
    members_title: '产品成员',
    members_desc: (id: string) => `${id} 下的用户成员关系。`,
    members_empty: '该产品还没有成员',
    row_actions: '行操作',
    suspend: '暂停',
    reactivate: '恢复',
    confirm_suspend: (user: string, product: string) => `暂停 ${user} 在 ${product} 的访问？`,
    confirm_revoke: (user: string, product: string) => `撤销 ${user} 在 ${product} 的访问？`,
    confirm_desc: '该用户在此产品下已签发的令牌会被撤销。',
    updated: '成员状态已更新',
    banned: '已封禁',
    ban_until: (time: string) => `至 ${time}`,
    ban_permanent: '永久',
    ban_reason: (reason: string) => `原因：${reason}`,
    ban: '封禁',
    unban: '解除封禁',
    impersonate: '以该用户身份登录',
    ban_title: (user: string) => `封禁 ${user}`,
    ban_desc: '封禁在整个平台生效：该用户的所有会话和令牌会被撤销，在所有产品中都无法登录。订阅了 user.banned 的 Webhook 会收到通知。',
    ban_reason_label: '原因（内部备注，仅所有者可见）',
    ban_expires_label: '到期时间（可选）',
    ban_expires_hint: '留空表示永久封禁，直到手动解除。按你的本地时区填写。',
    ban_done: '用户已封禁',
    unban_title: (user: string) => `解除封禁 ${user}？`,
    unban_desc: '该用户可以重新登录。订阅了 user.unbanned 的 Webhook 会收到通知。',
    unban_done: '已解除封禁',
    unban_unchanged: '该用户当前未被封禁',
    imp_title: (user: string) => `以 ${user} 的身份登录（支持会话）`,
    imp_desc: '用于排查用户报告的问题。请先阅读以下说明：',
    imp_point_confirm: (min: number) =>
      `会在新标签页打开身份域上的确认页，你需要在 ${min} 分钟内输入当前的 TOTP 验证码确认。`,
    imp_point_session: (min: number) => `支持会话最长 ${min} 分钟，不会延长。`,
    imp_point_audit: '整个过程会记入审计日志；产品收到的令牌带有 act 声明，可以识别出这是代登录。',
    imp_point_console: '在支持会话中无法使用控制台和账号设置。',
    imp_reason_label: (min: number) => `原因（至少 ${min} 个字符，会记入审计日志）`,
    imp_start: '继续，打开确认页',
    imp_started: '已在新标签页打开确认页',
    imp_ready: '确认页地址（如果新标签页被浏览器拦截，请手动打开）：',
    imp_open: '打开确认页',
    imp_mfa_required: '发起支持会话前，你的账号需要先开启两步验证（TOTP）。在身份域的账号页设置后再试。',
    imp_setup_2fa: '设置两步验证',
    imp_expires: (time: string) => `请在 ${time} 前完成确认。`,
    close: '关闭',
    export_title: '导出用户（CSV）',
    export_desc: (rows: number) => `导出所选环境中的全部用户。每次请求最多 ${rows} 行，会自动分页拼接；每次导出都会记入审计日志。`,
    export_include_email: '包含邮箱',
    export_button: '导出 CSV',
    export_done: (rows: string) => `已导出 ${rows} 行`,
    export_truncated: (rows: string) => `数据过多，只导出了前 ${rows} 行。`,
  },
  en: {
    find_title: 'Find a user',
    find_desc: 'Look up by user ID or exact email. Lookups are recorded in the audit log.',
    find_placeholder: 'usr_… or exact email',
    find_button: 'Look up',
    verified: 'Email verified',
    unverified: 'Email unverified',
    anonymous: 'Anonymous',
    scope_hint: 'Only memberships in products you may manage are shown.',
    col_product: 'Product',
    col_user: 'User',
    col_status: 'Status',
    col_joined: 'Joined',
    col_last_seen: 'Last seen',
    deletion_title: 'Deletion / export requests',
    deletion_none: 'No requests.',
    deletion_line: (kind: string, scope: string) => `${kind} (${scope})`,
    deletion_dates: (requested: string, due: string) => `Requested ${requested}, due ${due}`,
    members_title: 'Product members',
    members_desc: (id: string) => `User memberships of ${id}.`,
    members_empty: 'This product has no members yet',
    row_actions: 'Row actions',
    suspend: 'Suspend',
    reactivate: 'Reactivate',
    confirm_suspend: (user: string, product: string) => `Suspend ${user} for ${product}?`,
    confirm_revoke: (user: string, product: string) => `Revoke ${user} for ${product}?`,
    confirm_desc: 'Their tokens for this product will be revoked.',
    updated: 'Membership updated',
    banned: 'Banned',
    ban_until: (time: string) => `until ${time}`,
    ban_permanent: 'permanent',
    ban_reason: (reason: string) => `Reason: ${reason}`,
    ban: 'Ban',
    unban: 'Unban',
    impersonate: 'Sign in as this user',
    ban_title: (user: string) => `Ban ${user}`,
    ban_desc: 'A ban applies platform-wide: all sessions and tokens of this user are revoked and they cannot sign in to any product. Webhooks subscribed to user.banned are notified.',
    ban_reason_label: 'Reason (internal note, visible to owners only)',
    ban_expires_label: 'Expires (optional)',
    ban_expires_hint: 'Leave empty for a permanent ban until lifted manually. Entered in your local time zone.',
    ban_done: 'User banned',
    unban_title: (user: string) => `Unban ${user}?`,
    unban_desc: 'The user can sign in again. Webhooks subscribed to user.unbanned are notified.',
    unban_done: 'Ban lifted',
    unban_unchanged: 'This user was not banned',
    imp_title: (user: string) => `Sign in as ${user} (support session)`,
    imp_desc: 'For investigating problems a user reported. Please read first:',
    imp_point_confirm: (min: number) =>
      `A confirmation page on the identity domain opens in a new tab; confirm there with a current TOTP code within ${min} minutes.`,
    imp_point_session: (min: number) => `The support session lasts at most ${min} minutes and is never extended.`,
    imp_point_audit: 'Everything is recorded in the audit log; tokens issued to products carry an act claim identifying the impersonation.',
    imp_point_console: 'The console and account settings are unavailable inside the support session.',
    imp_reason_label: (min: number) => `Reason (at least ${min} characters, recorded in the audit log)`,
    imp_start: 'Continue to confirmation',
    imp_started: 'Confirmation page opened in a new tab',
    imp_ready: 'Confirmation page (open it manually if the browser blocked the new tab):',
    imp_open: 'Open confirmation page',
    imp_mfa_required: 'Support sessions require two-factor authentication (TOTP) on your own account. Set it up on the identity domain, then try again.',
    imp_setup_2fa: 'Set up two-factor authentication',
    imp_expires: (time: string) => `Confirm before ${time}.`,
    close: 'Close',
    export_title: 'Export users (CSV)',
    export_desc: (rows: number) => `Exports every user of the selected environment, ${rows} rows per request, fetched page by page. Each export is recorded in the audit log.`,
    export_include_email: 'Include email',
    export_button: 'Export CSV',
    export_done: (rows: string) => `Exported ${rows} rows`,
    export_truncated: (rows: string) => `Too many users: only the first ${rows} rows were exported.`,
  },
});

type Status = MembershipRow['status'];

function RowActions({ status, disabled, onChange }: { status: Status; disabled: boolean; onChange: (s: Status) => void }) {
  const t = useT(messages);
  const c = useT(common);
  if (status === 'revoked') return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" disabled={disabled} aria-label={t.row_actions}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {status === 'active' && <DropdownMenuItem onSelect={() => onChange('suspended')}>{t.suspend}</DropdownMenuItem>}
        {status === 'suspended' && <DropdownMenuItem onSelect={() => onChange('active')}>{t.reactivate}</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onChange('revoked')}>{c.revoke}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Owner-only ban dialog: reason (required) and optional expiry, sent as ISO 8601. */
function BanDialog({ userId, open, onOpenChange, onDone }: { userId: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const act = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { reason: reason.trim(), ...(expires ? { expires_at: new Date(expires).toISOString() } : {}) };
    if (await act.run(() => api.post(`/users/${encodeURIComponent(userId)}/ban`, body))) {
      toast.success(t.ban_done);
      setReason('');
      setExpires('');
      onOpenChange(false);
      onDone();
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); act.clear(); }}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t.ban_title(userId)}</DialogTitle>
            <DialogDescription>{t.ban_desc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ban-reason">{t.ban_reason_label}</Label>
            <Textarea id="ban-reason" required rows={3} maxLength={BAN_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ban-expires">{t.ban_expires_label}</Label>
            <Input id="ban-expires" type="datetime-local" className="w-auto" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <p className="text-muted-foreground text-xs">{t.ban_expires_hint}</p>
          </div>
          <ErrorBanner message={act.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{c.cancel}</Button>
            <Button type="submit" variant="destructive" disabled={act.busy || !reason.trim()}>
              {act.busy ? <Loader2 className="animate-spin" /> : <Ban />}
              {t.ban}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Identity domain (two-factor setup link); App.tsx has already validated the configuration. */
const issuer = (() => {
  try {
    return readConfig(import.meta.env as Record<string, string | undefined>, location.origin).issuer;
  } catch {
    return '';
  }
})();

/** Owner-only impersonation request; the owner confirms with TOTP on the identity domain. */
function ImpersonateDialog({ userId, open, onOpenChange }: { userId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const [reason, setReason] = useState('');
  const [started, setStarted] = useState<Impersonation | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  const act = useAction();
  const enough = reason.trim().length >= IMPERSONATION_REASON_MIN;
  async function submit(e: FormEvent) {
    e.preventDefault();
    let res: Impersonation | undefined;
    setNeedsMfa(false);
    const ok = await act.run(async () => {
      try {
        res = await api.post<Impersonation>(`/users/${encodeURIComponent(userId)}/impersonations`, { reason: reason.trim() });
      } catch (err) {
        // The owner has no TOTP yet: explain where to turn it on instead of the raw server message.
        if (err instanceof ApiRequestError && err.details?.reason === 'mfa_required') return setNeedsMfa(true);
        throw err;
      }
    });
    if (ok && res) {
      setStarted(res);
      window.open(res.url, '_blank', 'noopener');
      toast.success(t.imp_started);
    }
  }
  const change = (o: boolean) => {
    onOpenChange(o);
    act.clear();
    setNeedsMfa(false);
    if (!o) {
      setStarted(null);
      setReason('');
    }
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t.imp_title(userId)}</DialogTitle>
            <DialogDescription>{t.imp_desc}</DialogDescription>
          </DialogHeader>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            <li>{t.imp_point_confirm(IMPERSONATION_REQUEST_TTL_S / 60)}</li>
            <li>{t.imp_point_session(IMPERSONATION_MAX_S / 60)}</li>
            <li>{t.imp_point_audit}</li>
            <li>{t.imp_point_console}</li>
          </ul>
          {started ? (
            <div className="space-y-2">
              <p className="text-sm">{t.imp_ready}</p>
              <CopyText value={started.url} className="w-full" />
              <p className="text-muted-foreground text-xs">{t.imp_expires(f.time(Date.parse(started.expires_at)))}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="imp-reason">{t.imp_reason_label(IMPERSONATION_REASON_MIN)}</Label>
              <Textarea id="imp-reason" required rows={3} minLength={IMPERSONATION_REASON_MIN} maxLength={IMPERSONATION_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <ErrorBanner message={act.error} />
          {needsMfa && (
            <Alert>
              <ShieldAlert />
              <AlertDescription className="space-y-2">
                <p>{t.imp_mfa_required}</p>
                <Button type="button" size="sm" variant="outline" asChild>
                  <a href={`${issuer}/two-factor/setup`} target="_blank" rel="noopener">
                    <ExternalLink />
                    {t.imp_setup_2fa}
                  </a>
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            {started ? (
              <>
                <Button type="button" variant="outline" onClick={() => change(false)}>{t.close}</Button>
                <Button type="button" asChild>
                  <a href={started.url} target="_blank" rel="noopener">
                    <ExternalLink />
                    {t.imp_open}
                  </a>
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => change(false)}>{c.cancel}</Button>
                <Button type="submit" disabled={act.busy || !enough}>
                  {act.busy ? <Loader2 className="animate-spin" /> : <UserCog />}
                  {t.imp_start}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** At most this many export pages are fetched (USER_EXPORT_PAGE_ROWS each). */
const EXPORT_MAX_PAGES = 40;

/** Owner / product_admin: download every user of one environment as CSV, following X-Next-Cursor. */
function ExportUsers({ productId, envs }: { productId: string; envs: Environment[] }) {
  const { api } = useApp();
  const t = useT(messages);
  const f = useFormat();
  const { env, setEnv } = useProductEnv();
  const [includeEmail, setIncludeEmail] = useState(false);
  const act = useAction();
  async function run() {
    let csv = '';
    let rows = 0;
    let after: string | undefined;
    let pages = 0;
    const ok = await act.run(async () => {
      do {
        const { text, headers } = await api.getText(`/products/${productId}/environments/${env}/users/export`, { include_email: String(includeEmail), after });
        // Every page starts with the header row; keep only the first one.
        const body = pages === 0 ? text : text.slice(text.indexOf('\r\n') + 2);
        csv += body;
        rows += body.split('\r\n').filter(Boolean).length - (pages === 0 ? 1 : 0);
        after = headers.get('X-Next-Cursor') ?? undefined;
        pages++;
      } while (after && pages < EXPORT_MAX_PAGES);
    });
    if (!ok) return;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${productId}-${env}-users.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (after) toast.warning(t.export_truncated(f.number(rows)));
    else toast.success(t.export_done(f.number(rows)));
  }
  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium">{t.export_title}</h3>
        <p className="text-muted-foreground text-sm">{t.export_desc(USER_EXPORT_PAGE_ROWS)}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <EnvSelect labelled value={env} onChange={setEnv} envs={envs} />
        <div className="flex h-9 items-center gap-2">
          <Checkbox id="export-email" checked={includeEmail} onCheckedChange={(v) => setIncludeEmail(v === true)} />
          <Label htmlFor="export-email" className="font-normal">{t.export_include_email}</Label>
        </div>
        <Button variant="outline" disabled={act.busy} onClick={run}>
          {act.busy ? <Loader2 className="animate-spin" /> : <Download />}
          {t.export_button}
        </Button>
      </div>
      <ErrorBanner message={act.error} />
    </div>
  );
}

export function Users({ product }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const confirm = useConfirm();
  const owner = isOwner(me);
  const canExport = hasRole(me, product.id, 'product_admin');
  const [dialog, setDialog] = useState<'ban' | 'impersonate' | null>(null);
  const banAction = useAction();
  const list = useLoad((a) => a.get<{ memberships: MembershipRow[] }>(`/products/${product.id}/memberships`, { limit: 100 }), product.id);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<UserLookup | null>(null);
  const lookup = useAction();
  const change = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFound(null);
    const q = query.trim();
    await lookup.run(async () => setFound(await api.get<UserLookup>('/users', q.startsWith('usr_') ? { user_id: q } : { email: q })));
  }
  async function refreshFound(userId: string) {
    await lookup.run(async () => setFound(await api.get<UserLookup>('/users', { user_id: userId })));
  }
  async function unban(userId: string) {
    if (!(await confirm({ title: t.unban_title(userId), description: t.unban_desc, confirmLabel: t.unban }))) return;
    let changed = true;
    if (await banAction.run(async () => (changed = (await api.delete<{ changed: boolean }>(`/users/${encodeURIComponent(userId)}/ban`)).changed))) {
      if (changed) toast.success(t.unban_done);
      else toast.info(t.unban_unchanged);
      await refreshFound(userId);
    }
  }
  async function setStatus(userId: string, status: Status) {
    if (status !== 'active') {
      const ok = await confirm({
        title: status === 'suspended' ? t.confirm_suspend(userId, product.id) : t.confirm_revoke(userId, product.id),
        description: t.confirm_desc,
        confirmLabel: status === 'suspended' ? t.suspend : c.revoke,
        destructive: true,
      });
      if (!ok) return;
    }
    if (await change.run(() => api.patch(`/products/${product.id}/memberships/${userId}`, { status }))) {
      toast.success(t.updated);
      list.reload();
      if (found) await refreshFound(found.user.id);
    }
  }

  return (
    <>
      <Section title={t.find_title} description={t.find_desc}>
        <div className="space-y-4">
          <form onSubmit={submit} className="flex flex-wrap gap-2">
            <Input required className="min-w-0 flex-1 basis-64" placeholder={t.find_placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button disabled={lookup.busy}>
              {lookup.busy ? <Loader2 className="animate-spin" /> : <Search />}
              {t.find_button}
            </Button>
          </form>
          <ErrorBanner message={lookup.error ?? change.error ?? banAction.error} />
          {found && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{found.user.name}</span>
                  <CopyText value={found.user.id} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground break-all">{found.user.email}</span>
                  <Badge variant={found.user.email_verified ? 'secondary' : 'outline'}>{found.user.email_verified ? t.verified : t.unverified}</Badge>
                  {found.user.is_anonymous && <Badge variant="outline">{t.anonymous}</Badge>}
                  {found.ban?.banned && (
                    <Badge variant="destructive">
                      {t.banned}
                      {' · '}
                      {found.ban.expires_at ? t.ban_until(f.time(Date.parse(found.ban.expires_at))) : t.ban_permanent}
                    </Badge>
                  )}
                </div>
                {found.ban?.banned && found.ban.reason && <p className="text-muted-foreground text-sm break-words">{t.ban_reason(found.ban.reason)}</p>}
                {owner && !found.user.deleted_at && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {found.ban?.banned ? (
                      <Button size="sm" variant="outline" disabled={banAction.busy} onClick={() => unban(found.user.id)}>
                        {banAction.busy ? <Loader2 className="animate-spin" /> : <ShieldOff />}
                        {t.unban}
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDialog('ban')}>
                          <Ban />
                          {t.ban}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDialog('impersonate')}>
                          <UserCog />
                          {t.impersonate}
                        </Button>
                      </>
                    )}
                  </div>
                )}
                <p className="text-muted-foreground text-xs">{t.scope_hint}</p>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.col_product}</TableHead>
                      <TableHead>{t.col_status}</TableHead>
                      <TableHead>{t.col_joined}</TableHead>
                      <TableHead>{t.col_last_seen}</TableHead>
                      <TableHead className="w-10"><span className="sr-only">{c.actions}</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {found.memberships.map((m) => (
                      <TableRow key={m.product_id}>
                        <TableCell>
                          <div className="font-medium">{m.product_name}</div>
                          <div className="text-muted-foreground font-mono text-xs">{m.product_id}</div>
                        </TableCell>
                        <TableCell><StatusBadge status={m.status} /></TableCell>
                        <TableCell className="whitespace-nowrap">{f.time(m.joined_at)}</TableCell>
                        <TableCell className="whitespace-nowrap">{f.time(m.last_seen_at)}</TableCell>
                        <TableCell>
                          {m.product_id === product.id && <RowActions status={m.status} disabled={change.busy} onChange={(s) => setStatus(found.user.id, s)} />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t.deletion_title}</h4>
                {found.deletion_requests.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t.deletion_none}</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {found.deletion_requests.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span className="flex flex-wrap items-center gap-2">
                          {t.deletion_line(r.kind, `${r.scope}${r.product_id ? `: ${r.product_id}` : ''}`)}
                          <StatusBadge status={r.status} />
                        </span>
                        <span className="text-muted-foreground text-xs">{t.deletion_dates(f.time(r.requested_at), f.time(r.due_at))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {found && owner && (
            <>
              <BanDialog userId={found.user.id} open={dialog === 'ban'} onOpenChange={(o) => setDialog(o ? 'ban' : null)} onDone={() => refreshFound(found.user.id)} />
              <ImpersonateDialog userId={found.user.id} open={dialog === 'impersonate'} onOpenChange={(o) => setDialog(o ? 'impersonate' : null)} />
            </>
          )}
        </div>
      </Section>

      <Section title={t.members_title} description={t.members_desc(product.id)}>
        <div className="space-y-4">
          <ErrorBanner message={list.error} />
          <Loading loading={list.loading} />
          {list.data && list.data.memberships.length === 0 && <EmptyState title={t.members_empty} />}
          {list.data && list.data.memberships.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.col_user}</TableHead>
                    <TableHead>{t.col_status}</TableHead>
                    <TableHead>{t.col_joined}</TableHead>
                    <TableHead>{t.col_last_seen}</TableHead>
                    <TableHead className="w-10"><span className="sr-only">{c.actions}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.memberships.map((m) => (
                    <TableRow key={m.user_id}>
                      <TableCell><CopyText value={m.user_id} /></TableCell>
                      <TableCell><StatusBadge status={m.status} /></TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(m.joined_at)}</TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(m.last_seen_at)}</TableCell>
                      <TableCell><RowActions status={m.status} disabled={change.busy} onChange={(s) => setStatus(m.user_id, s)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {canExport && (
            <>
              <Separator />
              <ExportUsers productId={product.id} envs={product.environments.map((e) => e.env)} />
            </>
          )}
        </div>
      </Section>
    </>
  );
}
