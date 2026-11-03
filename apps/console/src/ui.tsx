// Shared console building blocks on top of shadcn/ui: data hooks, page layout pieces, status badges,
// one-time secret display and a promise-based confirm dialog. Pages compose these; they do not style raw HTML.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, Inbox, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { ENVIRONMENTS, type Environment } from '@z-cloudbase/contracts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ApiRequestError, type ApiClient } from './api.ts';
import { defineMessages, fmtBytes, useT } from './i18n.tsx';
import type { Me } from './types.ts';

export { fmtBytes };

/** Words used across pages. Page-specific text lives next to each page. */
export const common = defineMessages({
  zh: {
    loading: '加载中…',
    save: '保存',
    saving: '保存中…',
    cancel: '取消',
    confirm: '确认',
    create: '创建',
    delete: '删除',
    revoke: '撤销',
    copy: '复制',
    copied: '已复制',
    refresh: '刷新',
    search: '搜索',
    environment: '环境',
    actions: '操作',
    none: '暂无数据',
    saved: '已保存',
    yes: '是',
    no: '否',
    status_active: '启用',
    status_disabled: '已停用',
    status_archived: '已归档',
    status_revoked: '已撤销',
    status_suspended: '已暂停',
    status_pending: '处理中',
    status_completed: '已完成',
    status_failed: '失败',
    status_delivered: '已送达',
    status_cancelled: '已取消',
    env_dev: '开发',
    env_staging: '预发布',
    env_prod: '生产',
    secret_title: '请立即复制并妥善保存',
    secret_hint: '此值只显示这一次，关闭后无法再次查看。',
    secret_done: '我已保存',
  },
  en: {
    loading: 'Loading…',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    confirm: 'Confirm',
    create: 'Create',
    delete: 'Delete',
    revoke: 'Revoke',
    copy: 'Copy',
    copied: 'Copied',
    refresh: 'Refresh',
    search: 'Search',
    environment: 'Environment',
    actions: 'Actions',
    none: 'Nothing here yet',
    saved: 'Saved',
    yes: 'Yes',
    no: 'No',
    status_active: 'Active',
    status_disabled: 'Disabled',
    status_archived: 'Archived',
    status_revoked: 'Revoked',
    status_suspended: 'Suspended',
    status_pending: 'Pending',
    status_completed: 'Completed',
    status_failed: 'Failed',
    status_delivered: 'Delivered',
    status_cancelled: 'Cancelled',
    env_dev: 'Development',
    env_staging: 'Staging',
    env_prod: 'Production',
    secret_title: 'Copy this now and keep it safe',
    secret_hint: 'It is shown only once and cannot be retrieved later.',
    secret_done: 'I have stored it',
  },
});

// --- data ------------------------------------------------------------------------------------

export const AppContext = createContext<{ api: ApiClient; me: Me } | null>(null);
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}

export const errorText = (e: unknown) =>
  e instanceof ApiRequestError ? `${e.message} (${e.code}${e.requestId ? `, ${e.requestId}` : ''})` : e instanceof Error ? e.message : String(e);

/** Load data from the API; `reload()` refetches. Changing `key` refetches too. */
export function useLoad<T>(load: (api: ApiClient) => Promise<T>, key: string) {
  const { api } = useApp();
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const run = useCallback(load, [key]);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    run(api).then(
      (data) => live && setState({ data, loading: false }),
      (e) => live && setState({ loading: false, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, run, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** Run a mutation, surfacing its error text; resolves to true on success. */
export function useAction() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy, clear: () => setError(undefined) };
}

/** UI-side hints only; the server enforces RBAC on every call. */
export const isOwner = (me: Me) => me.grants.some((g) => g.role === 'owner');
export const hasRole = (me: Me, productId: string, ...roles: Me['grants'][number]['role'][]) =>
  me.grants.some((g) => (g.role === 'owner' || g.productId === productId) && (g.role === 'owner' || roles.includes(g.role)));

// --- layout ----------------------------------------------------------------------------------

/** Title row of a page or product section, with optional description and actions on the right. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-2">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A titled card; `action` sits in the header's right corner. */
export function Section({ title, description, action, children, className }: {
  title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export const ErrorBanner = ({ message, className }: { message?: string; className?: string }) =>
  message ? (
    <Alert variant="destructive" className={className}>
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;

/** Placeholder rows while data loads. */
export const Loading = ({ loading, rows = 3 }: { loading: boolean; rows?: number }) =>
  loading ? (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  ) : null;

export function EmptyState({ title, description, action }: { title?: ReactNode; description?: ReactNode; action?: ReactNode }) {
  const c = useT(common);
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <Inbox className="text-muted-foreground size-8" />
      <p className="font-medium">{title ?? c.none}</p>
      {description && <p className="text-muted-foreground max-w-sm text-sm">{description}</p>}
      {action}
    </div>
  );
}

// --- small widgets ---------------------------------------------------------------------------

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-success/10 text-success border-success/20',
  completed: 'bg-success/10 text-success border-success/20',
  pending: 'bg-warning/10 text-warning border-warning/30',
  suspended: 'bg-warning/10 text-warning border-warning/30',
  disabled: 'bg-destructive/10 text-destructive border-destructive/20',
  failed: 'bg-destructive/10 text-destructive border-destructive/20',
  revoked: 'bg-muted text-muted-foreground',
  archived: 'bg-muted text-muted-foreground',
  delivered: 'bg-success/10 text-success border-success/20',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Coloured status pill; known statuses are translated, others shown as given. */
export function StatusBadge({ status }: { status: string }) {
  const c = useT(common);
  const label = (c as Record<string, string>)[`status_${status}`] ?? status;
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-normal', STATUS_STYLE[status])}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

export function EnvBadge({ env }: { env: Environment }) {
  return (
    <Badge variant={env === 'prod' ? 'default' : 'secondary'} className="font-mono text-xs">
      {env}
    </Badge>
  );
}

/** Monospace value with a copy button (ids, keys, URLs). */
export function CopyText({ value, className }: { value: string; className?: string }) {
  const c = useT(common);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    setDone(true);
    toast.success(c.copied);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1500);
  };
  return (
    <span className={cn('bg-muted inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 font-mono text-xs', className)}>
      <span className="truncate">{value}</span>
      <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" onClick={copy} aria-label={c.copy}>
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  );
}

/** A small label above a control, for filter toolbars (`<div className="flex flex-wrap items-end gap-3">`). */
export function Field({ label, htmlFor, children, className }: { label: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs">{label}</Label>
      {children}
    </div>
  );
}

/** Environment picker; `labelled` wraps it in a `Field` so it lines up in filter toolbars. */
export function EnvSelect({ value, onChange, envs = ENVIRONMENTS, labelled = false }: {
  value: Environment; onChange: (e: Environment) => void; envs?: readonly Environment[]; labelled?: boolean;
}) {
  const c = useT(common);
  const select = (
    <Select value={value} onValueChange={(v) => onChange(v as Environment)}>
      <SelectTrigger className="w-auto min-w-40" aria-label={c.environment}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {envs.map((e) => (
          <SelectItem key={e} value={e}>
            <span className="font-mono">{e}</span>
            <span className="text-muted-foreground">· {c[`env_${e}`]}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return labelled ? <Field label={c.environment}>{select}</Field> : select;
}

/** A secret shown exactly once (service key, backup codes); dismissed explicitly by the user. */
export function OneTimeSecret({ title, value, onDone }: { title: ReactNode; value: string; onDone: () => void }) {
  const c = useT(common);
  return (
    <Alert className="border-primary/40 bg-primary/5" role="status">
      <KeyRound className="text-primary" />
      <div className="col-start-2 space-y-3">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{c.secret_title} — {c.secret_hint}</p>
        </div>
        <CopyText value={value} className="bg-background w-full border text-sm" />
        <Button size="sm" onClick={onDone}>{c.secret_done}</Button>
      </div>
    </Alert>
  );
}

// --- confirm dialog --------------------------------------------------------------------------

interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (!(await confirm({ title, destructive: true }))) return;` */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const c = useT(common);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <AlertDialog open={!!pending} onOpenChange={(open) => !open && close(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description && <AlertDialogDescription>{pending.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>{c.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className={cn(pending?.destructive && 'bg-destructive hover:bg-destructive/90 text-white')}
              onClick={() => close(true)}
            >
              {pending?.confirmLabel ?? c.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
