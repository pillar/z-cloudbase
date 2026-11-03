import { useState } from 'react';
import { Play } from 'lucide-react';
import type { RetentionResult } from '@z-cloudbase/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useT } from '../../i18n.tsx';
import { EmptyState, ErrorBanner, Field, Loading, Section, useLoad } from '../../ui.tsx';
import { analyticsPath, rangeKey, type AnalyticsTabProps } from './shared.tsx';

const messages = defineMessages({
  zh: {
    granularity: '粒度',
    day: '按天',
    week: '按周（UTC 周一起）',
    periods: (max: number) => `周期数（≤ ${max}）`,
    startEvent: '起始事件（可选）',
    returnEvent: '回访事件（可选）',
    anyEvent: '任意事件',
    userProperty: '用户属性（key:value）',
    run: '计算留存',
    title: '留存',
    description: '每行是一个 cohort：不填起始事件时为 actor 首次出现的日期，否则为起始事件在范围内首次发生的日期。各列是第 k 个周期内发生回访事件的比例。',
    cohort: 'Cohort',
    size: '人数',
    period: (g: 'day' | 'week', k: number) => (g === 'day' ? `第 ${k} 天` : `第 ${k} 周`),
    noCohorts: '所选时间范围内没有 cohort',
  },
  en: {
    granularity: 'Granularity',
    day: 'Daily',
    week: 'Weekly (UTC, Monday start)',
    periods: (max: number) => `Periods (≤ ${max})`,
    startEvent: 'Start event (optional)',
    returnEvent: 'Return event (optional)',
    anyEvent: 'Any event',
    userProperty: 'User property (key:value)',
    run: 'Compute retention',
    title: 'Retention',
    description: 'One row per cohort: the day an actor was first seen, or, with a start event, the day it first happened in the range. Column k is the share that did the return event in period k.',
    cohort: 'Cohort',
    size: 'Size',
    period: (g: 'day' | 'week', k: number) => (g === 'day' ? `Day ${k}` : `Week ${k}`),
    noCohorts: 'No cohorts in the selected range',
  },
});

type Granularity = 'day' | 'week';
const DAY_MS = 24 * 3600 * 1000;
const LIMITS: Record<Granularity, { def: number; max: number }> = { day: { def: 7, max: 31 }, week: { def: 4, max: 13 } };

interface RetentionQuery {
  granularity: Granularity;
  periods: number;
  start_event?: string;
  return_event?: string;
  user_property?: string;
}

export function Retention(p: AnalyticsTabProps) {
  const t = useT(messages);
  const f = useFormat();
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [periods, setPeriods] = useState(String(LIMITS.day.def));
  const [startEvent, setStartEvent] = useState('');
  const [returnEvent, setReturnEvent] = useState('');
  const [userProperty, setUserProperty] = useState('');
  const [applied, setApplied] = useState<RetentionQuery>({ granularity: 'day', periods: LIMITS.day.def });
  const q = useLoad(
    (a) => a.get<RetentionResult>(analyticsPath(p, 'retention'), { env: p.env, from: p.from, to: p.to, ...applied }),
    `${rangeKey(p)}|${JSON.stringify(applied)}`,
  );

  function changeGranularity(g: Granularity) {
    setGranularity(g);
    setPeriods(String(LIMITS[g].def));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const { def, max } = LIMITS[granularity];
    const n = Math.trunc(Number(periods));
    const clamped = Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
    setPeriods(String(clamped));
    setApplied({
      granularity,
      periods: clamped,
      start_event: startEvent.trim() || undefined,
      return_event: returnEvent.trim() || undefined,
      user_property: userProperty.trim() || undefined,
    });
  }

  const r = q.data;
  return (
    <>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label={t.granularity} htmlFor="rt-granularity">
          <Select value={granularity} onValueChange={(v) => changeGranularity(v as Granularity)}>
            <SelectTrigger id="rt-granularity" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">{t.day}</SelectItem>
              <SelectItem value="week">{t.week}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t.periods(LIMITS[granularity].max)} htmlFor="rt-periods">
          <Input id="rt-periods" type="number" min={1} max={LIMITS[granularity].max} className="w-28" value={periods} onChange={(e) => setPeriods(e.target.value)} />
        </Field>
        <Field label={t.startEvent} htmlFor="rt-start">
          <Input id="rt-start" className="w-44 font-mono" value={startEvent} onChange={(e) => setStartEvent(e.target.value)} />
        </Field>
        <Field label={t.returnEvent} htmlFor="rt-return">
          <Input id="rt-return" placeholder={t.anyEvent} className="w-44 font-mono" value={returnEvent} onChange={(e) => setReturnEvent(e.target.value)} />
        </Field>
        <Field label={t.userProperty} htmlFor="rt-user-prop">
          <Input id="rt-user-prop" placeholder="plan:pro" className="w-44 font-mono" value={userProperty} onChange={(e) => setUserProperty(e.target.value)} />
        </Field>
        <Button type="submit">
          <Play />
          {t.run}
        </Button>
      </form>
      <ErrorBanner message={q.error} />

      <Section title={t.title} description={t.description}>
        <Loading loading={q.loading} rows={4} />
        {!q.loading && r && r.cohorts.length === 0 && <EmptyState title={t.noCohorts} />}
        {!q.loading && r && r.cohorts.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.cohort}</TableHead>
                  <TableHead className="text-right">{t.size}</TableHead>
                  {Array.from({ length: r.periods }, (_, k) => (
                    <TableHead key={k} className="text-center">{t.period(r.granularity, k)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.cohorts.map((c) => (
                  <TableRow key={c.cohort}>
                    <TableCell className="font-mono text-xs">{c.cohort}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.number(c.size)}</TableCell>
                    {Array.from({ length: r.periods }, (_, k) => {
                      // A period that has not started yet has no data (the API reports 0): show "–", not 0%.
                      const future = Date.parse(`${c.cohort}T00:00:00Z`) + k * (r.granularity === 'week' ? 7 : 1) * DAY_MS > Date.now();
                      const n = future ? undefined : c.retained[k];
                      const ratio = n !== undefined && c.size > 0 ? n / c.size : undefined;
                      return (
                        <TableCell key={k} className="relative min-w-16 text-center" title={n !== undefined ? f.number(n) : undefined}>
                          {ratio !== undefined && (
                            <div className="bg-chart-1 absolute inset-0.5 rounded-sm" style={{ opacity: 0.06 + ratio * 0.5 }} />
                          )}
                          <span className="relative text-xs tabular-nums">{ratio !== undefined ? f.percent(ratio) : '–'}</span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </>
  );
}
