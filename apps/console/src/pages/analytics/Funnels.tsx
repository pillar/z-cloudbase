import { useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import type { FunnelResult } from '@z-cloudbase/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { defineMessages, useFormat, useT } from '../../i18n.tsx';
import { EmptyState, ErrorBanner, Field, Loading, Section, useLoad } from '../../ui.tsx';
import { Bar, DimensionSelect, analyticsPath, dimensionOptions, rangeKey, useAnalyticsSettings, type AnalyticsTabProps } from './shared.tsx';

const messages = defineMessages({
  zh: {
    stepsTitle: '漏斗步骤',
    stepsDescription: '按顺序填写 2–5 个事件名。第一步之后的每一步都必须在第一步发生后的转化窗口内完成。',
    step: (n: number) => `第 ${n} 步`,
    eventName: '事件名',
    addStep: '添加步骤',
    removeStep: '删除此步骤',
    window: '转化窗口',
    window_3600: '1 小时',
    window_86400: '1 天',
    window_604800: '7 天',
    window_2592000: '30 天',
    firstStepFilter: '第一步筛选',
    filterValue: '维度值',
    userProperty: '用户属性（key:value）',
    run: '计算漏斗',
    needSteps: '至少填写 2 个步骤后计算',
    resultTitle: '转化',
    resultDescription: (from: string, to: string) => `${from} 至 ${to}（UTC，不含结束日）。漏斗按 actor 计：登录用户或匿名设备。`,
    actors: '人数',
    ofFirst: '占第一步',
    ofPrevious: '占上一步',
    noActors: '第一步没有任何 actor',
  },
  en: {
    stepsTitle: 'Funnel steps',
    stepsDescription: 'Enter 2–5 event names in order. Each later step must happen within the conversion window after the first.',
    step: (n: number) => `Step ${n}`,
    eventName: 'Event name',
    addStep: 'Add step',
    removeStep: 'Remove this step',
    window: 'Conversion window',
    window_3600: '1 hour',
    window_86400: '1 day',
    window_604800: '7 days',
    window_2592000: '30 days',
    firstStepFilter: 'First-step filter',
    filterValue: 'Value',
    userProperty: 'User property (key:value)',
    run: 'Compute funnel',
    needSteps: 'Enter at least 2 steps to compute',
    resultTitle: 'Conversion',
    resultDescription: (from: string, to: string) => `${from} to ${to} (UTC, end exclusive). Counted per actor: a signed-in user or an anonymous device.`,
    actors: 'Actors',
    ofFirst: 'of first',
    ofPrevious: 'of previous',
    noActors: 'No actor reached the first step',
  },
});

const WINDOWS = [3600, 86400, 604800, 2592000] as const;
const MIN_STEPS = 2;
const MAX_STEPS = 5;

interface FunnelQuery {
  steps: string;
  window: string;
  filter?: string;
  user_property?: string;
}

export function Funnels(p: AnalyticsTabProps) {
  const t = useT(messages);
  const f = useFormat();
  const settings = useAnalyticsSettings(p);
  const [steps, setSteps] = useState<string[]>(['', '']);
  const [windowS, setWindowS] = useState('86400');
  const [filterDim, setFilterDim] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [userProperty, setUserProperty] = useState('');
  const [applied, setApplied] = useState<FunnelQuery | null>(null);

  const filled = steps.map((s) => s.trim()).filter(Boolean);
  const q = useLoad(
    (a) => (applied ? a.get<FunnelResult>(analyticsPath(p, 'funnel'), { env: p.env, from: p.from, to: p.to, ...applied }) : Promise.resolve(null)),
    `${rangeKey(p)}|${JSON.stringify(applied)}`,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (filled.length < MIN_STEPS) return;
    setApplied({
      steps: filled.join(','),
      window: windowS,
      filter: filterDim && filterValue ? `${filterDim}:${filterValue}` : undefined,
      user_property: userProperty.trim() || undefined,
    });
  }

  const setStep = (i: number, v: string) => setSteps((s) => s.map((x, j) => (j === i ? v : x)));
  const result = q.data;
  const first = result?.steps[0]?.actors ?? 0;

  return (
    <>
      <Section title={t.stepsTitle} description={t.stepsDescription}>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground w-16 shrink-0 text-xs">{t.step(i + 1)}</span>
                <Input
                  aria-label={`${t.step(i + 1)} · ${t.eventName}`}
                  placeholder={t.eventName}
                  className="max-w-sm font-mono"
                  value={s}
                  onChange={(e) => setStep(i, e.target.value)}
                />
                {steps.length > MIN_STEPS && (
                  <Button type="button" variant="ghost" size="icon" aria-label={t.removeStep} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>
                    <X />
                  </Button>
                )}
              </div>
            ))}
            {steps.length < MAX_STEPS && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setSteps((x) => [...x, ''])}>
                  <Plus />
                  {t.addStep}
                </Button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t.window} htmlFor="fn-window">
              <Select value={windowS} onValueChange={setWindowS}>
                <SelectTrigger id="fn-window" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => <SelectItem key={w} value={String(w)}>{t[`window_${w}`]}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t.firstStepFilter} htmlFor="fn-filter-dim">
              <DimensionSelect id="fn-filter-dim" optional value={filterDim} onChange={setFilterDim} options={dimensionOptions(settings.data)} />
            </Field>
            {filterDim && (
              <Field label={t.filterValue} htmlFor="fn-filter-value">
                <Input id="fn-filter-value" className="w-44 font-mono" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} />
              </Field>
            )}
            <Field label={t.userProperty} htmlFor="fn-user-prop">
              <Input id="fn-user-prop" placeholder="plan:pro" className="w-44 font-mono" value={userProperty} onChange={(e) => setUserProperty(e.target.value)} />
            </Field>
            <Button type="submit" disabled={filled.length < MIN_STEPS}>
              <Play />
              {t.run}
            </Button>
          </div>
        </form>
      </Section>

      <ErrorBanner message={q.error} />
      {!applied ? (
        <EmptyState title={t.needSteps} />
      ) : (
        <Section title={t.resultTitle} description={result ? t.resultDescription(result.from, result.to) : undefined}>
          <Loading loading={q.loading} rows={applied.steps.split(',').length} />
          {!q.loading && result && first === 0 && <EmptyState title={t.noActors} />}
          {!q.loading && result && first > 0 && (
            <ol className="space-y-4">
              {result.steps.map((s, i) => {
                const prev = i === 0 ? s.actors : result.steps[i - 1]!.actors;
                return (
                  <li key={i} className="space-y-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="text-muted-foreground text-xs">{i + 1}</span>
                        <span className="truncate font-mono text-xs">{s.event}</span>
                      </span>
                      <span className="text-muted-foreground flex gap-4 text-xs tabular-nums">
                        <span><span className="text-foreground text-sm font-medium">{f.number(s.actors)}</span> {t.actors}</span>
                        <span>{f.percent(s.conversion)} {t.ofFirst}</span>
                        {i > 0 && <span>{f.percent(prev ? s.actors / prev : 0)} {t.ofPrevious}</span>}
                      </span>
                    </div>
                    <Bar ratio={s.conversion} />
                  </li>
                );
              })}
            </ol>
          )}
        </Section>
      )}
    </>
  );
}
