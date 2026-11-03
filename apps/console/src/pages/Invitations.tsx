// Platform invitations (PRD §21.2): owners invite an email address to register (needed when the
// deployment runs SIGNUP_MODE=invite). With mail the link goes only to the invited address; without
// mail the server returns it once and it is shown here for the owner to pass on.
import { useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { CreatedInvitation, Invitation, InvitationStatus } from '@z-cloudbase/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useLocale, useT } from '../i18n.tsx';
import {
  CopyText, EmptyState, ErrorBanner, Loading, OneTimeSecret, PageHeader, Section, common, isOwner, useAction, useApp, useConfirm, useLoad,
} from '../ui.tsx';

const messages = defineMessages({
  zh: {
    title: '邀请',
    description: '邀请指定邮箱注册平台账号。部署为“仅邀请注册”时，这是创建账号的唯一方式。',
    owner_only: '只有平台所有者可以管理邀请。',
    invite: '邀请注册',
    invite_desc: '有邮件服务时，邀请链接只发送到该邮箱；没有邮件服务时，链接只在这里显示一次。',
    email: '邮箱',
    days: '有效天数',
    sending: '发送中…',
    created_mail: '邀请邮件已发送',
    created_link: '邀请已创建',
    link_title: '邀请链接（只显示一次，请转交给受邀人）',
    filter: '状态',
    all: '全部',
    status_pending: '待使用',
    status_used: '已使用',
    status_revoked: '已撤销',
    status_expired: '已过期',
    delivery_email: '邮件',
    delivery_link: '链接',
    col_email: '邮箱',
    col_status: '状态',
    col_delivery: '发送方式',
    col_created: '创建时间',
    col_expires: '过期时间',
    col_used_by: '注册账号',
    empty: '没有邀请',
    confirm_revoke: (email: string) => `撤销给 ${email} 的邀请？链接将立即失效。`,
    revoked: '邀请已撤销',
  },
  en: {
    title: 'Invitations',
    description: 'Invite an email address to register a platform account. With invite-only registration this is the only way to create accounts.',
    owner_only: 'Only platform owners can manage invitations.',
    invite: 'Invite',
    invite_desc: 'With mail configured, the link is sent only to this address; without mail it is shown here once.',
    email: 'Email',
    days: 'Valid for (days)',
    sending: 'Sending…',
    created_mail: 'Invitation mail sent',
    created_link: 'Invitation created',
    link_title: 'Invitation link (shown once — pass it on to the invitee)',
    filter: 'Status',
    all: 'All',
    status_pending: 'Pending',
    status_used: 'Used',
    status_revoked: 'Revoked',
    status_expired: 'Expired',
    delivery_email: 'Email',
    delivery_link: 'Link',
    col_email: 'Email',
    col_status: 'Status',
    col_delivery: 'Delivery',
    col_created: 'Created',
    col_expires: 'Expires',
    col_used_by: 'Account',
    empty: 'No invitations',
    confirm_revoke: (email: string) => `Revoke the invitation for ${email}? The link stops working at once.`,
    revoked: 'Invitation revoked',
  },
});

const STATUSES: InvitationStatus[] = ['pending', 'used', 'revoked', 'expired'];
const STATUS_VARIANT: Record<InvitationStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pending: 'default', used: 'secondary', revoked: 'outline', expired: 'outline',
};

export function Invitations() {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const { locale } = useLocale();
  const confirm = useConfirm();
  const [status, setStatus] = useState<InvitationStatus | 'all'>('pending');
  const owner = isOwner(me);
  const list = useLoad(
    (a) => (owner ? a.get<{ invitations: Invitation[] }>('/invitations', { status: status === 'all' ? undefined : status, limit: 200 }) : Promise.resolve({ invitations: [] })),
    `invitations:${status}`,
  );
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [days, setDays] = useState('7');
  const [link, setLink] = useState<string | null>(null);
  const create = useAction();
  const revoke = useAction();

  if (!owner) return <EmptyState title={t.owner_only} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    let created: CreatedInvitation | undefined;
    const ok = await create.run(async () => {
      created = await api.post<CreatedInvitation>('/invitations', { email: email.trim(), expires_in_days: Number(days), lang: locale });
    });
    if (!ok || !created) return;
    toast.success(created.url ? t.created_link : t.created_mail);
    if (created.url) setLink(created.url);
    setEmail('');
    setOpen(false);
    list.reload();
  }

  async function del(i: Invitation) {
    if (!(await confirm({ title: t.confirm_revoke(i.email), confirmLabel: c.revoke, destructive: true }))) return;
    if (await revoke.run(() => api.delete(`/invitations/${i.id}`))) {
      toast.success(t.revoked);
      list.reload();
    }
  }

  const inviteDialog = (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), create.clear())}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus />{t.invite}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t.invite}</DialogTitle>
            <DialogDescription>{t.invite_desc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="invite-email">{t.email}</Label>
            <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-days">{t.days}</Label>
            <Input id="invite-days" type="number" min={1} max={30} required value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          <ErrorBanner message={create.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{c.cancel}</Button>
            <Button disabled={create.busy}>
              {create.busy && <Loader2 className="animate-spin" />}
              {create.busy ? t.sending : t.invite}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  const statusFilter = (
    <Select value={status} onValueChange={(v) => setStatus(v as InvitationStatus | 'all')}>
      <SelectTrigger className="w-36" aria-label={t.filter}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t.all}</SelectItem>
        {STATUSES.map((s) => <SelectItem key={s} value={s}>{t[`status_${s}`]}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t.title} description={t.description} actions={inviteDialog} />
      {link && <OneTimeSecret title={t.link_title} value={link} onDone={() => setLink(null)} />}
      <Section title={t.title} action={statusFilter}>
        <div className="space-y-4">
          <ErrorBanner message={list.error ?? revoke.error} />
          <Loading loading={list.loading} />
          {list.data && list.data.invitations.length === 0 && <EmptyState title={t.empty} />}
          {list.data && list.data.invitations.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.col_email}</TableHead>
                    <TableHead>{t.col_status}</TableHead>
                    <TableHead>{t.col_delivery}</TableHead>
                    <TableHead>{t.col_created}</TableHead>
                    <TableHead>{t.col_expires}</TableHead>
                    <TableHead>{t.col_used_by}</TableHead>
                    <TableHead className="w-10"><span className="sr-only">{c.actions}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.invitations.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>{i.email}</TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[i.status]}>{t[`status_${i.status}`]}</Badge></TableCell>
                      <TableCell>{t[`delivery_${i.delivery}`]}</TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(Date.parse(i.created_at))}</TableCell>
                      <TableCell className="whitespace-nowrap">{f.time(Date.parse(i.expires_at))}</TableCell>
                      <TableCell>{i.used_by ? <CopyText value={i.used_by} /> : <span className="text-muted-foreground">–</span>}</TableCell>
                      <TableCell>
                        {i.status === 'pending' && (
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive size-8" disabled={revoke.busy} onClick={() => del(i)} aria-label={c.revoke}>
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
