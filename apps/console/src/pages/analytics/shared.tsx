// Pieces shared by the Analytics tabs: props, settings loading, the dimension picker and small displays.
import { BUILTIN_DIMENSIONS, type AnalyticsSettings, type Environment } from '@z-cloudbase/contracts';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { defineMessages, useT } from '../../i18n.tsx';
import { useLoad } from '../../ui.tsx';
import type { ProductDetail as Product } from '../../types.ts';

const messages = defineMessages({
  zh: {
    sourceLabel: '数据源',
    sourceAnalyticsEngine: 'Analytics Engine',
    sourceSubstitute: '本地替身（非 Analytics Engine）',
    empty: '—（空）',
    dimension: '维度',
    noDimension: '不筛选',
  },
  en: {
    sourceLabel: 'Source',
    sourceAnalyticsEngine: 'Analytics Engine',
    sourceSubstitute: 'local substitute, not Analytics Engine',
    empty: '— (empty)',
    dimension: 'Dimension',
    noDimension: 'No filter',
  },
});

/** Every Analytics tab gets the product plus the environment and UTC date range chosen above the tabs. */
export interface AnalyticsTabProps {
  product: Product;
  env: Environment;
  /** `YYYY-MM-DD` or '' (server default: last 7 days). */
  from: string;
  /** Exclusive `YYYY-MM-DD` or ''. */
  to: string;
}

export const analyticsPath = (p: AnalyticsTabProps, rest: string) => `/products/${p.product.id}/analytics/${rest}`;
export const rangeKey = (p: AnalyticsTabProps) => `${p.product.id}|${p.env}|${p.from}|${p.to}`;

/** Declared custom dimensions and retention settings of one product environment. */
export function useAnalyticsSettings(p: Pick<AnalyticsTabProps, 'product' | 'env'>) {
  return useLoad(
    (a) => a.get<AnalyticsSettings>(`/products/${p.product.id}/analytics/settings`, { env: p.env }),
    `${p.product.id}|${p.env}|settings`,
  );
}

/** Built-in dimensions plus `prop:<key>` for each declared key. */
export const dimensionOptions = (settings?: AnalyticsSettings): string[] => [
  ...BUILTIN_DIMENSIONS,
  ...(settings?.dimensions ?? []).map((k) => `prop:${k}`),
];

/** UTC date `YYYY-MM-DD`, `offset` days from today. */
export const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const NONE = '__none__';

/** Dimension picker; with `optional`, '' means "no dimension" (shown as "No filter"). */
export function DimensionSelect({ id, value, onChange, options, optional = false, className = 'w-44' }: {
  id?: string; value: string; onChange: (v: string) => void; options: string[]; optional?: boolean; className?: string;
}) {
  const t = useT(messages);
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger id={id} className={className} aria-label={t.dimension}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value={NONE}>{t.noDimension}</SelectItem>}
        {options.map((d) => (
          <SelectItem key={d} value={d}><span className="font-mono">{d}</span></SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Which backend answered (production Analytics Engine or the local D1 substitute). */
export function SourceNote({ source }: { source: string }) {
  const t = useT(messages);
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
      {t.sourceLabel}
      <Badge variant="outline" className="font-mono font-normal">{source}</Badge>
      {source === 'd1_substitute' ? t.sourceSubstitute : t.sourceAnalyticsEngine}
    </p>
  );
}

/** A dimension value; the empty string is shown as an explicit "(empty)" label. */
export function DimValue({ value }: { value: string }) {
  const t = useT(messages);
  return value === '' ? <span className="text-muted-foreground italic">{t.empty}</span> : <span className="font-mono text-xs">{value}</span>;
}

/** Thin horizontal bar, `ratio` in 0..1 (same style as Overview's top events). */
export function Bar({ ratio, className = 'bg-chart-1' }: { ratio: number; className?: string }) {
  return (
    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
      <div className={`${className} h-full rounded-full`} style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} />
    </div>
  );
}
