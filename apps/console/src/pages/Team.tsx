import { useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import { shellMessages } from '../shell.tsx';
import type { TeamMember } from '../types.ts';
import { CopyText, EmptyState, ErrorBanner, Loading, Section, common, useAction, useApp, useConfirm, useLoad } from '../ui.tsx';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    title: '团队成员',
    desc: '可以管理此产品的平台账号。',
    add: '添加成员',
    add_desc: '输入已有账号的用户 ID，并选择其在此产品下的角色。',
    user_id: '用户 ID',
    user_placeholder: 'usr_…（已有账号）',
    role: '角色',
    col_user: '用户',
    col_scope: '范围',
    col_added: '添加时间',
    scope_all: '所有产品',
    you: '你',
    empty: '还没有团队成员',
    remove: '移除',
    adding: '添加中…',
    added: '成员已添加',
    removed: '成员已移除',
    confirm_remove: (user: string, role: string, product: string) => `从 ${product} 移除 ${user}（${role}）？`,
  },
  en: {
    title: 'Team',
    desc: 'Platform accounts that can manage this product.',
    add: 'Add member',
    add_desc: 'Enter the user ID of an existing account and choose its role on this product.',
    user_id: 'User ID',
    user_placeholder: 'usr_… (existing account)',
    role: 'Role',
    col_user: 'User',
    col_scope: 'Scope',
    col_added: 'Added',
    scope_all: 'All products',
    you: 'you',
    empty: 'No team members yet',
    remove: 'Remove',
    adding: 'Adding…',
    added: 'Member added',
    removed: 'Member removed',
    confirm_remove: (user: string, role: string, product: string) => `Remove ${user} (${role}) from ${product}?`,
  },
});

type AssignableRole = 'product_admin' | 'product_developer';
const ASSIGNABLE: AssignableRole[] = ['product_admin', 'product_developer'];

export function Team({ product }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const roles = useT(shellMessages);
  const f = useFormat();
  const confirm = useConfirm();
  const list = useLoad((a) => a.get<{ members: TeamMember[] }>(`/products/${product.id}/team`), product.id);
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<AssignableRole>('product_developer');
  const add = useAction();
  const remove = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await add.run(() => api.post('/team', { user_id: userId.trim(), role, product_id: product.id }))) {
      toast.success(t.added);
      setUserId('');
      setOpen(false);
      list.reload();
    }
  }
  async function del(m: TeamMember) {
    const ok = await confirm({
      title: t.confirm_remove(m.user_id, roles[`role_${m.role}`], product.id),
      confirmLabel: t.remove,
      destructive: true,
    });
    if (ok && (await remove.run(() => api.delete(`/team/${m.id}`)))) {
      toast.success(t.removed);
      list.reload();
    }
  }

  const addDialog = (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), add.clear())}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus />{t.add}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t.add}</DialogTitle>
            <DialogDescription>{t.add_desc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="team-user-id">{t.user_id}</Label>
            <Input id="team-user-id" required placeholder={t.user_placeholder} value={userId} onChange={(e) => setUserId(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-role">{t.role}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AssignableRole)}>
              <SelectTrigger id="team-role" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASSIGNABLE.map((r) => <SelectItem key={r} value={r}>{roles[`role_${r}`]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <ErrorBanner message={add.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{c.cancel}</Button>
            <Button disabled={add.busy}>
              {add.busy && <Loader2 className="animate-spin" />}
              {add.busy ? t.adding : t.add}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return (
    <Section title={t.title} description={t.desc} action={addDialog}>
      <div className="space-y-4">
        <ErrorBanner message={list.error ?? remove.error} />
        <Loading loading={list.loading} />
        {list.data && list.data.members.length === 0 && <EmptyState title={t.empty} />}
        {list.data && list.data.members.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.col_user}</TableHead>
                  <TableHead>{t.role}</TableHead>
                  <TableHead>{t.col_scope}</TableHead>
                  <TableHead>{t.col_added}</TableHead>
                  <TableHead className="w-10"><span className="sr-only">{c.actions}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <CopyText value={m.user_id} />
                        {m.user_id === me.user_id && <Badge variant="outline">{t.you}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="secondary">{roles[`role_${m.role}`]}</Badge></TableCell>
                    <TableCell>{m.product_id ? <span className="font-mono text-xs">{m.product_id}</span> : <span className="text-muted-foreground">{t.scope_all}</span>}</TableCell>
                    <TableCell className="whitespace-nowrap">{f.time(m.created_at)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive size-8" disabled={remove.busy} onClick={() => del(m)} aria-label={t.remove}>
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
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
