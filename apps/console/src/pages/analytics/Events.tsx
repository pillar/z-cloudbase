import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Filter, Loader2, Search, X } from 'lucide-react';
import type { ExplorerEvent, ExplorerResult } from '@z-cloudbase/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useT } from '../../i18n.tsx';
import { CopyText, EmptyState, ErrorBanner, Field, Loading, Section, common, useAction, useApp, useLoad } from '../../ui.tsx';
import { DimValue, DimensionSelect, analyticsPath, dimensionOptions, rangeKey, useAnalyticsSettings, type AnalyticsTabProps } from './shared.tsx';

const messages = defineMessages({
  zh: {
    event: '事件名',
    actor: 'Actor（user_key 或 anon:…）',
    filter: '维度筛选',
    filterValue: '值',
    title: '事件明细',
    description: '最新的事件在前。点击左侧箭头查看属性。',
    time: '时间（UTC）',
    actorCol: 'Actor',
    path: '路径',
    client: '浏览器 / 系统 / 设备',
    country: '国家',
    expand: '展开属性',
    collapse: '收起属性',
    filterActor: '只看此 actor',
    clearActor: '清除 actor 筛选',
    properties: '属性',
    dims: '自定义维度',
    noProperties: '没有属性',
    truncated: '属性超过 1 KB，未保存在明细中；完整属性见导出。',
    session: '会话',
    loadMore: '加载更多',
    noEvents: '没有匹配的事件',
    userProperties: '用户属性',
    userPropertiesDescription: (actor: string) => `${actor} 当前的用户属性。`,
    noUserProperties: '此 actor 没有用户属性',
  },
  en: {
    event: 'Event name',
    actor: 'Actor (user_key or anon:…)',
    filter: 'Dimension filter',
    filterValue: 'Value',
    title: 'Events',
    description: 'Newest first. Use the arrow on the left to see properties.',
    time: 'Time (UTC)',
    actorCol: 'Actor',
    path: 'Path',
    client: 'Browser / OS / device',
    country: 'Country',
    expand: 'Show properties',
    collapse: 'Hide properties',
    filterActor: 'Only this actor',
    clearActor: 'Clear actor filter',
    properties: 'Properties',
    dims: 'Custom dimensions',
    noProperties: 'No properties',
    truncated: 'Properties exceed 1 KB and are not stored with the row; the full properties are in the export.',
    session: 'Session',
    loadMore: 'Load more',
    noEvents: 'No matching events',
    userProperties: 'User properties',
    userPropertiesDescription: (actor: string) => `Current user properties of ${actor}.`,
    noUserProperties: 'This actor has no user properties',
  },
});

const actorOf = (e: ExplorerEvent) => e.user_key ?? (e.anonymous_id ? `anon:${e.anonymous_id}` : null);

interface EventsQuery {
  event?: string;
  actor?: string;
  filter?: string;
}

export function Events(p: AnalyticsTabProps) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const settings = useAnalyticsSettings(p);
  const [event, setEvent] = useState('');
  const [actor, setActor] = useState('');
  const [filterDim, setFilterDim] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [applied, setApplied] = useState<EventsQuery>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const key = `${rangeKey(p)}|${JSON.stringify(applied)}`;
  const query = { env: p.env, from: p.from, to: p.to, ...applied };
  const first = useLoad((a) => a.get<ExplorerResult>(analyticsPath(p, 'events'), query), key);
  // Older pages fetched with "Load more"; tied to the query they belong to.
  const [more, setMore] = useState<{ key: string; events: ExplorerEvent[]; next: string | null }>();
  const extra = more?.key === key ? more : undefined;
  const events = [...(first.data?.events ?? []), ...(extra?.events ?? [])];
  const cursor = extra ? extra.next : (first.data?.next_before ?? null);
  const loadMore = useAction();

  function apply(next: { event: string; actor: string; filterDim: string; filterValue: string }) {
    const q: EventsQuery = {
      event: next.event.trim() || undefined,
      actor: next.actor.trim() || undefined,
      filter: next.filterDim ? `${next.filterDim}:${next.filterValue}` : undefined,
    };
    // Same filters again: refetch the newest page.
    if (JSON.stringify(q) === JSON.stringify(applied)) first.reload();
    else setApplied(q);
    setMore(undefined);
    setOpen(new Set());
  }
  const current = { event, actor, filterDim, filterValue };
  function submit(e: React.FormEvent) {
    e.preventDefault();
    apply(current);
  }
  function showActor(a: string) {
    setActor(a);
    apply({ ...current, actor: a });
  }
  function fetchMore() {
    if (!cursor) return;
    void loadMore.run(async () => {
      const r = await api.get<ExplorerResult>(analyticsPath(p, 'events'), { ...query, before: cursor });
      setMore({ key, events: [...(extra?.events ?? []), ...r.events], next: r.next_before });
    });
  }
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  return (
    <>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label={t.event} htmlFor="ev-event">
          <Input id="ev-event" className="w-44 font-mono" value={event} onChange={(e) => setEvent(e.target.value)} />
        </Field>
        <Field label={t.actor} htmlFor="ev-actor">
          <div className="flex items-center gap-1">
            <Input id="ev-actor" placeholder="usr_… / anon:…" className="w-60 font-mono" value={actor} onChange={(e) => setActor(e.target.value)} />
            {applied.actor && (
              <Button type="button" variant="ghost" size="icon" aria-label={t.clearActor} onClick={() => showActor('')}>
                <X />
              </Button>
            )}
          </div>
        </Field>
        <Field label={t.filter} htmlFor="ev-filter-dim">
          <DimensionSelect id="ev-filter-dim" optional value={filterDim} onChange={setFilterDim} options={dimensionOptions(settings.data)} />
        </Field>
        {filterDim && (
          <Field label={t.filterValue} htmlFor="ev-filter-value">
            <Input id="ev-filter-value" className="w-44 font-mono" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} />
          </Field>
        )}
        <Button type="submit" disabled={first.loading}>
          {first.loading ? <Loader2 className="animate-spin" /> : <Search />}
          {c.search}
        </Button>
      </form>
      <ErrorBanner message={first.error} />

      {applied.actor && first.data && first.data.user_properties !== undefined && (
        <Section title={t.userProperties} description={t.userPropertiesDescription(applied.actor)}>
          {first.data.user_properties && Object.keys(first.data.user_properties).length > 0 ? (
            <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">{JSON.stringify(first.data.user_properties, null, 2)}</pre>
          ) : (
            <p className="text-muted-foreground text-sm">{t.noUserProperties}</p>
          )}
        </Section>
      )}

      <Section title={t.title} description={t.description}>
        <Loading loading={first.loading} rows={5} />
        {!first.loading && first.data && events.length === 0 && <EmptyState title={t.noEvents} />}
        {!first.loading && events.length > 0 && (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t.time}</TableHead>
                    <TableHead>{t.event}</TableHead>
                    <TableHead>{t.actorCol}</TableHead>
                    <TableHead>{t.path}</TableHead>
                    <TableHead>{t.client}</TableHead>
                    <TableHead>{t.country}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => {
                    const a = actorOf(e);
                    const isOpen = open.has(e.event_id);
                    return (
                      <Fragment key={e.event_id}>
                        <TableRow className="align-top">
                          <TableCell className="py-1.5">
                            <Button type="button" variant="ghost" size="icon" className="size-7" aria-expanded={isOpen} aria-label={isOpen ? t.collapse : t.expand} onClick={() => toggle(e.event_id)}>
                              {isOpen ? <ChevronDown /> : <ChevronRight />}
                            </Button>
                          </TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">{e.occurred_at}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {e.event_name}
                            {e.source === 'server' && <Badge variant="outline" className="ml-2 font-normal">server</Badge>}
                          </TableCell>
                          <TableCell>
                            {a ? (
                              <div className="flex items-center gap-1">
                                <CopyText value={a} className="max-w-48" />
                                {a !== applied.actor && (
                                  <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t.filterActor} title={t.filterActor} onClick={() => showActor(a)}>
                                    <Filter className="size-3.5" />
                                  </Button>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">–</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-56 truncate"><DimValue value={e.path} /></TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{[e.browser, e.os, e.device].map((v) => v || '–').join(' / ')}</TableCell>
                          <TableCell className="font-mono text-xs">{e.country || '–'}</TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell />
                            <TableCell colSpan={6} className="space-y-2 whitespace-normal">
                              <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                                <span>event_id <span className="font-mono">{e.event_id}</span></span>
                                {e.session_id && <span>{t.session} <span className="font-mono">{e.session_id}</span></span>}
                                <span>received_at <span className="font-mono">{e.received_at}</span></span>
                              </div>
                              {Object.keys(e.dims).length > 0 && (
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  <span className="text-muted-foreground">{t.dims}</span>
                                  {Object.entries(e.dims).map(([k, v]) => (
                                    <Badge key={k} variant="secondary" className="font-mono font-normal">{k}={v}</Badge>
                                  ))}
                                </div>
                              )}
                              {e.properties_truncated ? (
                                <p className="text-muted-foreground text-xs">{t.truncated}</p>
                              ) : e.properties && Object.keys(e.properties).length > 0 ? (
                                <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">{JSON.stringify(e.properties, null, 2)}</pre>
                              ) : (
                                <p className="text-muted-foreground text-xs">{t.noProperties}</p>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <ErrorBanner message={loadMore.error} />
            {cursor && (
              <div className="flex justify-center">
                <Button type="button" variant="outline" disabled={loadMore.busy} onClick={fetchMore}>
                  {loadMore.busy && <Loader2 className="animate-spin" />}
                  {t.loadMore}
                </Button>
              </div>
            )}
          </div>
        )}
      </Section>
    </>
  );
}
