import { useState } from 'react';
import { Loader2, Play, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { ANALYTICS_CUSTOM_DIMENSIONS_MAX, USER_PROPERTY_KEY_RE, type AnalyticsSettings, type BreakdownResult } from '@z-cloudbase/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { defineMessages, useFormat, useT } from '../../i18n.tsx';
import { EmptyState, ErrorBanner, Field, Loading, Section, common, hasRole, useAction, useApp, useLoad } from '../../ui.tsx';
import {
  Bar, DimValue, DimensionSelect, SourceNote, analyticsPath, dimensionOptions, rangeKey, useAnalyticsSettings, type AnalyticsTabProps,
} from './shared.tsx';

const messages = defineMessages({
  zh: {
    by: '分组维度',
    event: '事件名（可选）',
    anyEvent: '全部事件',
    filters: '筛选（最多 3 个）',
    filterValue: '值',
    addFilter: '添加筛选',
    removeFilter: '删除筛选',
    limit: '行数',
    run: '分组',
    title: '分组结果',
    description: '按所选维度统计事件数与登录用户数（不同 user_key）。生产环境的去重用户数在采样时为近似值。',
    value: '值',
    events: '事件',
    users: '用户',
    noRows: '所选范围内没有数据',
    dimsTitle: '自定义维度',
    dimsDescription: (max: number) => `最多 ${max} 个事件属性键，按顺序成为可分组、可筛选的维度 prop:<key>。只影响此后写入的事件。`,
    dimKey: (n: number) => `维度 ${n}`,
    invalidKey: (k: string) => `“${k}” 不合法：只能使用字母、数字和下划线，最长 64 个字符`,
    duplicateKey: (k: string) => `“${k}” 重复`,
    retention: (days: number, archive: number) => `事件明细与漏斗 / 留存数据保留 ${days} 天；原始事件归档保留 ${archive} 天。`,
    readOnly: '只有产品管理员可以修改自定义维度。',
  },
  en: {
    by: 'Group by',
    event: 'Event (optional)',
    anyEvent: 'All events',
    filters: 'Filters (up to 3)',
    filterValue: 'Value',
    addFilter: 'Add filter',
    removeFilter: 'Remove filter',
    limit: 'Rows',
    run: 'Break down',
    title: 'Breakdown',
    description: 'Events and signed-in users (distinct user_key) per value. In production the distinct user count is approximate when sampled.',
    value: 'Value',
    events: 'Events',
    users: 'Users',
    noRows: 'No data in the selected range',
    dimsTitle: 'Custom dimensions',
    dimsDescription: (max: number) => `Up to ${max} event property keys, in order, become dimensions prop:<key> you can group and filter by. Only affects events written afterwards.`,
    dimKey: (n: number) => `Dimension ${n}`,
    invalidKey: (k: string) => `"${k}" is invalid: letters, digits and underscore only, up to 64 characters`,
    duplicateKey: (k: string) => `"${k}" is listed twice`,
    retention: (days: number, archive: number) => `Event rows and funnel / retention data are kept ${days} days; the raw event archive is kept ${archive} days.`,
    readOnly: 'Only a product admin can change custom dimensions.',
  },
});

const LIMITS = ['10', '20', '50'] as const;
const MAX_FILTERS = 3;

interface FilterRow {
  dim: string;
  value: string;
}
interface BreakdownQuery {
  by: string;
  limit: string;
  event?: string;
  filter: string[];
}

export function Breakdown(p: AnalyticsTabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const f = useFormat();
  const settings = useAnalyticsSettings(p);
  const options = dimensionOptions(settings.data);
  const [by, setBy] = useState('event_name');
  const [event, setEvent] = useState('');
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [limit, setLimit] = useState<string>('20');
  const [applied, setApplied] = useState<BreakdownQuery>({ by: 'event_name', limit: '20', filter: [] });
  const q = useLoad(
    (a) => a.get<BreakdownResult>(analyticsPath(p, 'breakdown'), { env: p.env, from: p.from, to: p.to, ...applied }),
    `${rangeKey(p)}|${JSON.stringify(applied)}`,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setApplied({
      by,
      limit,
      event: event.trim() || undefined,
      filter: filters.filter((x) => x.dim).map((x) => `${x.dim}:${x.value}`),
    });
  }
  const setFilter = (i: number, patch: Partial<FilterRow>) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const rows = q.data?.rows ?? [];
  const max = Math.max(1, ...rows.map((r) => r.events));

  return (
    <>
      <form onSubmit={submit} className="grid gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t.by} htmlFor="bd-by">
            <DimensionSelect id="bd-by" value={by} onChange={setBy} options={options} />
          </Field>
          <Field label={t.event} htmlFor="bd-event">
            <Input id="bd-event" placeholder={t.anyEvent} className="w-44 font-mono" value={event} onChange={(e) => setEvent(e.target.value)} />
          </Field>
          <Field label={t.limit} htmlFor="bd-limit">
            <Select value={limit} onValueChange={setLimit}>
              <SelectTrigger id="bd-limit" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit">
            <Play />
            {t.run}
          </Button>
        </div>
        <Field label={t.filters}>
          <div className="grid gap-2">
            {filters.map((x, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <DimensionSelect value={x.dim} onChange={(dim) => setFilter(i, { dim })} options={options} />
                <Input aria-label={t.filterValue} placeholder={t.filterValue} className="w-44 font-mono" value={x.value} onChange={(e) => setFilter(i, { value: e.target.value })} />
                <Button type="button" variant="ghost" size="icon" aria-label={t.removeFilter} onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            {filters.length < MAX_FILTERS && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setFilters((fs) => [...fs, { dim: 'event_name', value: '' }])}>
                  <Plus />
                  {t.addFilter}
                </Button>
              </div>
            )}
          </div>
        </Field>
      </form>
      <ErrorBanner message={q.error} />

      <Section title={t.title} description={t.description}>
        <Loading loading={q.loading} rows={4} />
        {!q.loading && q.data && (
          <div className="space-y-3">
            {rows.length === 0 ? (
              <EmptyState title={t.noRows} />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead><span className="font-mono">{q.data.by}</span></TableHead>
                      <TableHead className="w-2/5">{t.events}</TableHead>
                      <TableHead className="text-right">{t.users}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.value}>
                        <TableCell className="max-w-xs truncate"><DimValue value={r.value} /></TableCell>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="flex-1"><Bar ratio={r.events / max} /></div>
                            <span className="w-16 text-right tabular-nums">{f.number(r.events)}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.users == null ? '–' : f.number(r.users)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <SourceNote source={q.data.source} />
          </div>
        )}
      </Section>

      <Section title={t.dimsTitle} description={t.dimsDescription(ANALYTICS_CUSTOM_DIMENSIONS_MAX)}>
        <ErrorBanner message={settings.error} />
        <Loading loading={settings.loading && !settings.data} rows={2} />
        {settings.data && (
          <DimensionsForm
            key={`${p.env}:${settings.data.dimensions.join(',')}`}
            settings={settings.data}
            canWrite={hasRole(me, p.product.id, 'product_admin')}
            save={async (dimensions) => {
              await api.put(analyticsPath(p, 'settings') + `?env=${p.env}`, { dimensions });
              settings.reload();
            }}
          />
        )}
      </Section>
    </>
  );
}

function DimensionsForm({ settings, canWrite, save }: { settings: AnalyticsSettings; canWrite: boolean; save: (d: string[]) => Promise<void> }) {
  const t = useT(messages);
  const c = useT(common);
  const [keys, setKeys] = useState<string[]>(() =>
    Array.from({ length: ANALYTICS_CUSTOM_DIMENSIONS_MAX }, (_, i) => settings.dimensions[i] ?? ''),
  );
  const [formError, setFormError] = useState<string>();
  const action = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const list = keys.map((k) => k.trim()).filter(Boolean);
    const bad = list.find((k) => !USER_PROPERTY_KEY_RE.test(k));
    const dup = list.find((k, i) => list.indexOf(k) !== i);
    const err = bad ? t.invalidKey(bad) : dup ? t.duplicateKey(dup) : undefined;
    setFormError(err);
    if (!err && (await action.run(() => save(list)))) toast.success(c.saved);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <fieldset disabled={!canWrite} className="flex flex-wrap items-end gap-3">
        {keys.map((k, i) => (
          <Field key={i} label={t.dimKey(i + 1)} htmlFor={`bd-dim-${i}`}>
            <Input id={`bd-dim-${i}`} placeholder="plan" className="w-40 font-mono" value={k} onChange={(e) => setKeys((ks) => ks.map((x, j) => (j === i ? e.target.value : x)))} />
          </Field>
        ))}
        {canWrite && (
          <Button type="submit" disabled={action.busy}>
            {action.busy && <Loader2 className="animate-spin" />}
            {c.save}
          </Button>
        )}
      </fieldset>
      <ErrorBanner message={formError ?? action.error} />
      <p className="text-muted-foreground text-sm">{t.retention(settings.retention_days, settings.archive_retention_days)}</p>
      {!canWrite && <p className="text-muted-foreground text-sm">{t.readOnly}</p>}
    </form>
  );
}
