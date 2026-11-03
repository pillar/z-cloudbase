import { useState, type FormEvent } from 'react';
import { Loader2, MoreHorizontal, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import type { MembershipRow, UserLookup } from '../types.ts';
import { CopyText, EmptyState, ErrorBanner, Loading, Section, StatusBadge, common, useAction, useApp, useConfirm, useLoad } from '../ui.tsx';
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

export function Users({ product }: TabProps) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const confirm = useConfirm();
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
      if (found) await lookup.run(async () => setFound(await api.get<UserLookup>('/users', { user_id: found.user.id })));
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
          <ErrorBanner message={lookup.error ?? change.error} />
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
                </div>
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
        </div>
      </Section>
    </>
  );
}
