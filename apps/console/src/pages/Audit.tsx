import { useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import type { AuditEntry } from '../types.ts';
import { CopyText, EmptyState, ErrorBanner, Loading, Section, common, useLoad } from '../ui.tsx';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    title: '审计日志',
    desc: '此产品最近 200 条管理操作记录。',
    filter_placeholder: '按操作、操作者或目标筛选',
    col_time: '时间',
    col_actor: '操作者',
    col_action: '操作',
    col_env: '环境',
    col_target: '目标',
    col_request: '请求 ID',
    col_details: '详情',
    empty: '暂无审计记录',
    no_match: '没有符合筛选条件的记录',
  },
  en: {
    title: 'Audit log',
    desc: 'The latest 200 administrative actions on this product.',
    filter_placeholder: 'Filter by action, actor or target',
    col_time: 'Time',
    col_actor: 'Actor',
    col_action: 'Action',
    col_env: 'Env',
    col_target: 'Target',
    col_request: 'Request ID',
    col_details: 'Details',
    empty: 'No audit entries',
    no_match: 'No entries match the filter',
  },
});

const targetOf = (e: AuditEntry) => (e.target_type ? `${e.target_type}:${e.target_id}` : '');

export function Audit({ product }: TabProps) {
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const q = useLoad((a) => a.get<{ entries: AuditEntry[] }>('/audit', { product_id: product.id, limit: 200 }), product.id);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const entries = (q.data?.entries ?? []).filter(
    (e) => !needle || [e.action, e.actor_id, targetOf(e)].some((v) => v.toLowerCase().includes(needle)),
  );

  return (
    <Section
      title={t.title}
      description={t.desc}
      action={
        <Button variant="outline" size="sm" onClick={q.reload} disabled={q.loading}>
          {q.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {c.refresh}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input className="pl-9" placeholder={t.filter_placeholder} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <ErrorBanner message={q.error} />
        <Loading loading={q.loading && !q.data} rows={5} />
        {q.data && q.data.entries.length === 0 && <EmptyState title={t.empty} />}
        {q.data && q.data.entries.length > 0 && entries.length === 0 && <EmptyState title={t.no_match} />}
        {entries.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.col_time}</TableHead>
                  <TableHead>{t.col_actor}</TableHead>
                  <TableHead>{t.col_action}</TableHead>
                  <TableHead>{t.col_env}</TableHead>
                  <TableHead>{t.col_target}</TableHead>
                  <TableHead>{t.col_request}</TableHead>
                  <TableHead>{t.col_details}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => {
                  const meta = JSON.stringify(e.metadata);
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap">{f.time(e.occurred_at)}</TableCell>
                      <TableCell><CopyText value={e.actor_id} /></TableCell>
                      <TableCell><Badge variant="secondary" className="font-mono">{e.action}</Badge></TableCell>
                      <TableCell>{e.env ? <span className="font-mono text-xs">{e.env}</span> : '–'}</TableCell>
                      <TableCell className="font-mono text-xs">{targetOf(e) || '–'}</TableCell>
                      <TableCell>{e.request_id ? <CopyText value={e.request_id} /> : '–'}</TableCell>
                      <TableCell>
                        {meta === '{}' ? '–' : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <code className="text-muted-foreground block max-w-48 cursor-default truncate text-xs">{meta}</code>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm font-mono text-xs break-all">{JSON.stringify(e.metadata, null, 2)}</TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Section>
  );
}
