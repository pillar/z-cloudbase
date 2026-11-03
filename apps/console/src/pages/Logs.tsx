import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { LOG_LEVELS, type Environment } from '@z-cloudbase/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { defineMessages, useT } from '../i18n.tsx';
import { CopyText, EmptyState, EnvSelect, Field, ErrorBanner, Loading, Section, common, useAction, useApp } from '../ui.tsx';
import type { LogRecord } from '../types.ts';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    requestId: '请求 ID',
    level: '级别',
    anyLevel: '全部级别',
    from: '开始时间',
    to: '结束时间',
    resultsTitle: '日志',
    resultsDescription: '按环境和时间窗口的结构化检索，默认最近 24 小时，最新的在前。',
    loadOlder: '加载更早的日志',
    allLoaded: '已显示全部匹配的日志',
    time: '时间',
    source: '来源',
    message: '消息',
    request: '请求',
    attributes: '属性',
    noMatches: '没有匹配的日志',
    notSearched: '设置条件后点击搜索',
  },
  en: {
    requestId: 'Request id',
    level: 'Level',
    anyLevel: 'Any level',
    from: 'From',
    to: 'To',
    resultsTitle: 'Logs',
    resultsDescription: 'Structured search by environment and time window; defaults to the last 24 hours, newest first.',
    loadOlder: 'Load older entries',
    allLoaded: 'All matching entries are shown',
    time: 'Time',
    source: 'Source',
    message: 'Message',
    request: 'Request',
    attributes: 'Attributes',
    noMatches: 'No matching log entries',
    notSearched: 'Set filters and press Search',
  },
});

const LEVEL_STYLE: Record<string, string> = {
  error: 'bg-destructive/10 text-destructive border-destructive/20',
  warn: 'bg-warning/10 text-warning border-warning/30',
  info: 'bg-muted text-muted-foreground',
  debug: 'bg-muted text-muted-foreground',
};
const ANY = 'any';

// Structured search only (PRD D07): environment + time window + optional request id / level. Defaults to the last 24 h.
export function Logs({ product }: TabProps) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const [env, setEnv] = useState<Environment>('dev');
  const [requestId, setRequestId] = useState('');
  const [level, setLevel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [logs, setLogs] = useState<LogRecord[] | null>(null);
  // Query of the shown results and the cursor for the next (older) page.
  const [page, setPage] = useState<{ query: Record<string, string>; next: string | null } | null>(null);
  const search = useAction();
  const more = useAction();
  const fetchPage = (query: Record<string, string>) =>
    api.get<{ logs: LogRecord[]; next_before: string | null }>(`/products/${product.id}/logs`, query);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await search.run(async () => {
      const q = new URLSearchParams({ env });
      if (requestId) q.set('request_id', requestId.trim());
      if (level) q.set('level', level);
      if (from) q.set('from', new Date(from).toISOString());
      if (to) q.set('to', new Date(to).toISOString());
      // Pin the window so later pages stay consistent with the first one.
      if (!to) q.set('to', new Date().toISOString());
      const query = Object.fromEntries(q);
      const res = await fetchPage(query);
      setLogs(res.logs);
      setPage({ query, next: res.next_before });
    });
  }

  async function loadOlder() {
    if (!page?.next) return;
    const { query, next } = page;
    await more.run(async () => {
      const res = await fetchPage({ ...query, before: next });
      setLogs((l) => [...(l ?? []), ...res.logs]);
      setPage({ query, next: res.next_before });
    });
  }

  return (
    <>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <EnvSelect labelled value={env} onChange={setEnv} />
        <Field label={t.requestId} htmlFor="log-request">
          <Input id="log-request" placeholder="req_…" className="w-48 font-mono" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
        </Field>
        <Field label={t.level} htmlFor="log-level">
          <Select value={level || ANY} onValueChange={(v) => setLevel(v === ANY ? '' : v)}>
            <SelectTrigger id="log-level" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t.anyLevel}</SelectItem>
              {LOG_LEVELS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t.from} htmlFor="log-from">
          <Input id="log-from" type="datetime-local" className="w-52" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t.to} htmlFor="log-to">
          <Input id="log-to" type="datetime-local" className="w-52" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button type="submit" disabled={search.busy}>
          {search.busy ? <Loader2 className="animate-spin" /> : <Search />}
          {c.search}
        </Button>
      </form>
      <ErrorBanner message={search.error} />

      <Section title={t.resultsTitle} description={t.resultsDescription}>
        <Loading loading={search.busy} />
        {!search.busy && logs === null && <EmptyState title={t.notSearched} />}
        {!search.busy && logs && logs.length === 0 && <EmptyState title={t.noMatches} />}
        {!search.busy && logs && logs.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.time}</TableHead>
                  <TableHead>{t.level}</TableHead>
                  <TableHead>{t.source}</TableHead>
                  <TableHead>{t.message}</TableHead>
                  <TableHead>{t.request}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l, i) => (
                  <TableRow key={i} className="align-top">
                    <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">{l.entry.timestamp}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('font-mono text-xs font-normal', LEVEL_STYLE[l.entry.level])}>{l.entry.level}</Badge>
                    </TableCell>
                    <TableCell>{l.source}</TableCell>
                    <TableCell className="max-w-xl whitespace-normal">
                      <div className="font-mono text-xs break-words">{l.entry.message}</div>
                      {l.entry.attributes && Object.keys(l.entry.attributes).length > 0 && (
                        <details className="text-muted-foreground mt-1 text-xs">
                          <summary className="cursor-pointer select-none">{t.attributes}</summary>
                          <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-2 font-mono">{JSON.stringify(l.entry.attributes, null, 2)}</pre>
                        </details>
                      )}
                    </TableCell>
                    <TableCell><CopyText value={l.entry.request_id ?? l.ingest_request_id} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!search.busy && logs && logs.length > 0 && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <ErrorBanner message={more.error} className="w-full" />
            {page?.next ? (
              <Button variant="outline" size="sm" disabled={more.busy} onClick={loadOlder}>
                {more.busy && <Loader2 className="animate-spin" />}
                {t.loadOlder}
              </Button>
            ) : (
              <p className="text-muted-foreground text-xs">{t.allLoaded}</p>
            )}
          </div>
        )}
      </Section>
    </>
  );
}
