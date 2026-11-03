import { Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import { EmptyState, EnvSelect, Field, ErrorBanner, Loading, Section, useLoad } from '../ui.tsx';
import { useProductEnv } from '../productEnv.tsx';
import type { AnalyticsSummary } from '../types.ts';
import type { TabProps } from './ProductDetail.tsx';
import { SourceNote, type AnalyticsTabProps } from './analytics/shared.tsx';

// Each tab beyond Overview is its own chunk, loaded when first opened.
const lazyTab = <K extends string>(load: () => Promise<Record<K, ComponentType<AnalyticsTabProps>>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Funnels = lazyTab(() => import('./analytics/Funnels.tsx'), 'Funnels');
const Retention = lazyTab(() => import('./analytics/Retention.tsx'), 'Retention');
const Breakdown = lazyTab(() => import('./analytics/Breakdown.tsx'), 'Breakdown');
const Events = lazyTab(() => import('./analytics/Events.tsx'), 'Events');
const Export = lazyTab(() => import('./analytics/Export.tsx'), 'Export');

const messages = defineMessages({
  zh: {
    from: '开始日期',
    to: '结束日期（不含）',
    totalEvents: '事件总数',
    latestUsers: '最近一天活跃用户',
    peakUsers: '单日活跃用户峰值',
    latestAnonymous: '最近一天匿名用户',
    trendTitle: '每日趋势',
    trendDescription: '按 UTC 日期统计的活跃用户与事件数。',
    users: '用户',
    events: '事件',
    anonymous: '匿名用户',
    dayUtc: '日期（UTC）',
    dailyTitle: '每日明细',
    topTitle: '热门事件',
    topDescription: '按触发次数排序。',
    noData: '所选时间范围内没有数据',
    noTop: '没有事件记录',
    tab_overview: '概览',
    tab_funnels: '漏斗',
    tab_retention: '留存',
    tab_breakdown: '分组',
    tab_events: '事件明细',
    tab_export: '导出',
    rangeHint: '日期按 UTC；留空时默认最近 7 天，并截到保留期内。',
    view: '视图',
  },
  en: {
    from: 'From',
    to: 'To (exclusive)',
    totalEvents: 'Total events',
    latestUsers: 'Users, latest day',
    peakUsers: 'Peak daily users',
    latestAnonymous: 'Anonymous, latest day',
    trendTitle: 'Daily trend',
    trendDescription: 'Active users and events per UTC day.',
    users: 'Users',
    events: 'Events',
    anonymous: 'Anonymous',
    dayUtc: 'Day (UTC)',
    dailyTitle: 'Daily breakdown',
    topTitle: 'Top events',
    topDescription: 'Ranked by number of occurrences.',
    noData: 'No data in the selected range',
    noTop: 'No events recorded',
    tab_overview: 'Overview',
    tab_funnels: 'Funnels',
    tab_retention: 'Retention',
    tab_breakdown: 'Breakdown',
    tab_events: 'Events',
    tab_export: 'Export',
    rangeHint: 'UTC dates; empty means the last 7 days, clamped to the retention window.',
    view: 'View',
  },
});

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card text-card-foreground flex flex-col gap-1 rounded-xl border p-4 shadow-sm">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground font-mono text-xs">{hint}</span>}
    </div>
  );
}

const TABS = ['overview', 'funnels', 'retention', 'breakdown', 'events', 'export'] as const;
type TabId = (typeof TABS)[number];

export function Analytics({ product }: TabProps) {
  const t = useT(messages);
  const { env, setEnv, envs } = useProductEnv();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState<TabId>('overview');
  // Tabs stay mounted once opened so their inputs survive switching; each loads its chunk on first open.
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(new Set(['overview']));
  const p: AnalyticsTabProps = { product, env, from, to };
  const views: Record<TabId, ReactNode> = {
    overview: <Overview {...p} />,
    funnels: <Funnels {...p} />,
    retention: <Retention {...p} />,
    breakdown: <Breakdown {...p} />,
    events: <Events {...p} />,
    export: <Export {...p} />,
  };
  const open = (v: string) => {
    setTab(v as TabId);
    setOpened((s) => new Set(s).add(v as TabId));
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <EnvSelect labelled value={env} onChange={setEnv} envs={envs} />
        <Field label={t.from} htmlFor="an-from">
          <Input id="an-from" type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t.to} htmlFor="an-to">
          <Input id="an-to" type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <p className="text-muted-foreground pb-2 text-xs">{t.rangeHint}</p>
      </div>
      <Tabs value={tab} onValueChange={open} className="gap-6">
        {/* Phones get a select (six tabs do not fit 390 px); wider screens the tab bar. */}
        <Select value={tab} onValueChange={open}>
          <SelectTrigger className="w-full sm:hidden" aria-label={t.view}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TABS.map((id) => <SelectItem key={id} value={id}>{t[`tab_${id}`]}</SelectItem>)}
          </SelectContent>
        </Select>
        <TabsList className="hidden sm:inline-flex">
          {TABS.map((id) => <TabsTrigger key={id} value={id}>{t[`tab_${id}`]}</TabsTrigger>)}
        </TabsList>
        {TABS.filter((id) => opened.has(id)).map((id) => (
          <TabsContent key={id} value={id} forceMount className="space-y-6 data-[state=inactive]:hidden">
            <Suspense fallback={<Loading loading rows={4} />}>{views[id]}</Suspense>
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

function Overview({ product, env, from, to }: AnalyticsTabProps) {
  const t = useT(messages);
  const f = useFormat();
  const q = useLoad(
    (a) => a.get<AnalyticsSummary>(`/products/${product.id}/analytics`, { env, from, to }),
    `${product.id}|${env}|${from}|${to}`,
  );

  const config = {
    users: { label: t.users, color: 'var(--chart-1)' },
    events: { label: t.events, color: 'var(--chart-2)' },
  } satisfies ChartConfig;
  const daily = q.data?.daily ?? [];
  const latest = daily.at(-1);
  const peak = daily.reduce<AnalyticsSummary['daily'][number] | undefined>((best, d) => (!best || d.users > best.users ? d : best), undefined);
  const topMax = Math.max(1, ...(q.data?.top_events.map((e) => e.count) ?? []));

  return (
    <>
      <ErrorBanner message={q.error} />
      <Loading loading={q.loading} rows={4} />
      {q.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t.totalEvents} value={f.number(q.data.events_total)} hint={q.data.source} />
            <Stat label={t.latestUsers} value={latest ? f.number(latest.users) : '–'} hint={latest?.day} />
            <Stat label={t.peakUsers} value={peak ? f.number(peak.users) : '–'} hint={peak?.day} />
            <Stat label={t.latestAnonymous} value={latest ? f.number(latest.anonymous) : '–'} hint={latest?.day} />
          </div>
          <SourceNote source={q.data.source} />

          <Section title={t.trendTitle} description={t.trendDescription}>
            {daily.length === 0 ? (
              <EmptyState title={t.noData} />
            ) : (
              <ChartContainer config={config} className="aspect-auto h-72 w-full">
                <AreaChart data={daily} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis yAxisId="users" width={36} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis yAxisId="events" orientation="right" width={44} tickLine={false} axisLine={false} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area yAxisId="events" dataKey="events" type="monotone" stroke="var(--color-events)" fill="var(--color-events)" fillOpacity={0.15} strokeWidth={2} />
                  <Area yAxisId="users" dataKey="users" type="monotone" stroke="var(--color-users)" fill="var(--color-users)" fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              </ChartContainer>
            )}
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t.topTitle} description={t.topDescription}>
              {q.data.top_events.length === 0 ? (
                <EmptyState title={t.noTop} />
              ) : (
                <ol className="space-y-3">
                  {q.data.top_events.map((e) => (
                    <li key={e.name} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="truncate font-mono text-xs">{e.name}</span>
                        <span className="text-muted-foreground tabular-nums">{f.number(e.count)}</span>
                      </div>
                      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                        <div className="bg-chart-1 h-full rounded-full" style={{ width: `${(e.count / topMax) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            <Section title={t.dailyTitle}>
              {daily.length === 0 ? (
                <EmptyState title={t.noData} />
              ) : (
                <div className="max-h-80 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.dayUtc}</TableHead>
                        <TableHead className="text-right">{t.users}</TableHead>
                        <TableHead className="text-right">{t.anonymous}</TableHead>
                        <TableHead className="text-right">{t.events}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {daily.map((d) => (
                        <TableRow key={d.day}>
                          <TableCell className="font-mono text-xs">{d.day}</TableCell>
                          <TableCell className="text-right tabular-nums">{f.number(d.users)}</TableCell>
                          <TableCell className="text-right tabular-nums">{f.number(d.anonymous)}</TableCell>
                          <TableCell className="text-right tabular-nums">{f.number(d.events)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Section>
          </div>
        </>
      )}
    </>
  );
}
