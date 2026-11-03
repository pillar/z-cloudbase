import { Activity, Database, Files } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import { EmptyState, EnvBadge, ErrorBanner, Loading, Section, useLoad } from '../ui.tsx';
import type { UsageResponse } from '../types.ts';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    estimate: '以下为平台元数据估算值，并非计费数据；此处不会显示文件内容。',
    stored: '已存储',
    objects: '个对象',
    objectsColumn: '对象数',
    quotaUsed: '配额使用',
    events: (days: number) => `事件（近 ${days} 天，估算）`,
    unavailable: '不可用',
    detailTitle: '明细',
    detailDescription: '各环境的存储与事件用量。',
    env: '环境',
    of: '配额',
    empty: '暂无用量数据',
    source: '数据源',
  },
  en: {
    estimate: 'Estimates from platform metadata, not billing figures. File contents are never shown here.',
    stored: 'Stored',
    objects: 'objects',
    objectsColumn: 'Objects',
    quotaUsed: 'Quota used',
    events: (days: number) => `Events (${days} d, est.)`,
    unavailable: 'unavailable',
    detailTitle: 'Details',
    detailDescription: 'Storage and event usage per environment.',
    env: 'Environment',
    of: 'of',
    empty: 'No usage data',
    source: 'Source',
  },
});

const percent = (used: number, quota: number) => (quota > 0 ? (used / quota) * 100 : 0);

function QuotaBar({ value }: { value: number }) {
  return (
    <div className="bg-muted h-2 w-full overflow-hidden rounded-full" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <div
        className={cn('h-full rounded-full', value >= 90 ? 'bg-destructive' : value >= 75 ? 'bg-warning' : 'bg-primary')}
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
  );
}

export function Usage({ product }: TabProps) {
  const t = useT(messages);
  const f = useFormat();
  const q = useLoad((a) => a.get<UsageResponse>(`/products/${product.id}/usage`), product.id);
  const windowDays = q.data?.usage.find((u) => u.events)?.events?.window_days ?? 30;

  return (
    <>
      <p className="text-muted-foreground text-sm">{t.estimate}</p>
      <ErrorBanner message={q.error} />
      <Loading loading={q.loading} rows={2} />
      {q.data && q.data.usage.length === 0 && <EmptyState title={t.empty} />}
      {q.data && q.data.usage.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {q.data.usage.map((u) => {
              const pct = percent(u.storage.bytes, u.storage.quota_bytes);
              return (
                <Section
                  key={u.env}
                  title={<EnvBadge env={u.env} />}
                  description={`${t.events(u.events?.window_days ?? windowDays)}: ${u.events ? f.number(u.events.total) : t.unavailable}`}
                >
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="text-2xl font-semibold tabular-nums">{f.bytes(u.storage.bytes)}</span>
                      <span className="text-muted-foreground text-sm tabular-nums">{t.of} {f.bytes(u.storage.quota_bytes)}</span>
                    </div>
                    <QuotaBar value={pct} />
                    <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
                      <span className="flex items-center gap-1"><Files className="size-3.5" />{f.number(u.storage.objects)} {t.objects}</span>
                      <span>{pct.toFixed(1)}%</span>
                    </div>
                  </div>
                </Section>
              );
            })}
          </div>

          <Section title={t.detailTitle} description={t.detailDescription}>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.env}</TableHead>
                    <TableHead><span className="inline-flex items-center gap-1"><Database className="size-3.5" />{t.stored}</span></TableHead>
                    <TableHead>{t.objectsColumn}</TableHead>
                    <TableHead className="min-w-48">{t.quotaUsed}</TableHead>
                    <TableHead><span className="inline-flex items-center gap-1"><Activity className="size-3.5" />{t.events(windowDays)}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.usage.map((u) => {
                    const pct = percent(u.storage.bytes, u.storage.quota_bytes);
                    return (
                      <TableRow key={u.env}>
                        <TableCell><EnvBadge env={u.env} /></TableCell>
                        <TableCell className="tabular-nums">{f.bytes(u.storage.bytes)}</TableCell>
                        <TableCell className="tabular-nums">{f.number(u.storage.objects)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="w-24"><QuotaBar value={pct} /></div>
                            <span className="text-muted-foreground text-xs tabular-nums">{pct.toFixed(1)}% · {f.bytes(u.storage.quota_bytes)}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {u.events ? (
                            <span className="inline-flex items-center gap-2 tabular-nums">
                              {f.number(u.events.total)}
                              <Badge variant="outline" className="font-mono text-xs font-normal" title={t.source}>{u.events.source}</Badge>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{t.unavailable}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
