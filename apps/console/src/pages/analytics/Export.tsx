import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { EXPORT_MAX_DAYS } from '@z-cloudbase/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { defineMessages, useT } from '../../i18n.tsx';
import { EnvBadge, ErrorBanner, Field, Section, useAction, useApp } from '../../ui.tsx';
import { analyticsPath, useAnalyticsSettings, utcDay, type AnalyticsTabProps } from './shared.tsx';

const messages = defineMessages({
  zh: {
    title: '导出原始事件',
    description: '从 R2 归档（gzip 压缩的 NDJSON）中导出所选环境的原始事件。',
    from: '开始日期（UTC）',
    to: '结束日期（UTC，不含）',
    format: '格式',
    ndjson: 'NDJSON（每行一个事件，与归档相同）',
    csv: 'CSV（properties 为 JSON 字符串）',
    download: '下载',
    downloading: '正在导出…',
    started: '导出已下载',
    required: '请填写开始和结束日期',
    order: '结束日期必须晚于开始日期',
    tooLong: (max: number) => `范围最多 ${max} 天`,
    note1: (max: number) => `范围按 UTC 日期，结束日期不含，最多 ${max} 天；范围内归档对象过多时会被拒绝，请缩小范围。`,
    note2: '已删除账号（或退出产品）的用户事件不会出现在导出中；只有匿名 ID 的事件无法归属到账号，不在删除范围内。',
    note3: (days?: number) => (days ? `归档保留 ${days} 天，更早的日期已被清理。` : '归档按部署配置的保留期清理。'),
    note4: '每次导出都写入审计日志（范围、格式、对象数）。开发者只能导出 dev / staging。',
  },
  en: {
    title: 'Export raw events',
    description: 'Raw events of the selected environment, from the R2 archive (gzip NDJSON).',
    from: 'From (UTC)',
    to: 'To (UTC, exclusive)',
    format: 'Format',
    ndjson: 'NDJSON (one event per line, as archived)',
    csv: 'CSV (properties as a JSON string)',
    download: 'Download',
    downloading: 'Exporting…',
    started: 'Export downloaded',
    required: 'Enter both dates',
    order: 'The end date must be after the start date',
    tooLong: (max: number) => `The range can span at most ${max} days`,
    note1: (max: number) => `UTC dates, end exclusive, at most ${max} days; a range with too many archive objects is refused, so narrow it.`,
    note2: 'Events of deleted users (or users who left the product) are excluded. Events with only an anonymous id cannot be tied to an account and are not covered by deletion.',
    note3: (days?: number) => (days ? `The archive is kept ${days} days; older dates have been purged.` : 'The archive is purged after the deployment\'s retention period.'),
    note4: 'Every export is recorded in the audit log (range, format, object count). Developers can export dev / staging only.',
  },
});

type Format = 'ndjson' | 'csv';
const DAY_MS = 86_400_000;

export function Export(p: AnalyticsTabProps) {
  const { api } = useApp();
  const t = useT(messages);
  const settings = useAnalyticsSettings(p);
  const [from, setFrom] = useState(p.from || utcDay(-6));
  const [to, setTo] = useState(p.to || utcDay(1));
  const [format, setFormat] = useState<Format>('ndjson');
  const [formError, setFormError] = useState<string>();
  const action = useAction();

  function validate(): string | undefined {
    if (!from || !to) return t.required;
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (!(days > 0)) return t.order;
    if (days > EXPORT_MAX_DAYS) return t.tooLong(EXPORT_MAX_DAYS);
    return undefined;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const err = validate();
    setFormError(err);
    if (err) return;
    const ok = await action.run(async () => {
      const blob = await api.download(analyticsPath(p, 'export'), { env: p.env, from, to, format });
      const url = URL.createObjectURL(blob);
      // The one place the console builds a DOM element imperatively: a download link for the blob.
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.product.id}-${p.env}-${from}-${to}.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
    if (ok) toast.success(t.started);
  }

  return (
    <Section title={t.title} description={t.description} action={<EnvBadge env={p.env} />}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t.from} htmlFor="ex-from">
            <Input id="ex-from" type="date" required className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t.to} htmlFor="ex-to">
            <Input id="ex-to" type="date" required className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label={t.format} htmlFor="ex-format">
            <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
              <SelectTrigger id="ex-format" className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ndjson">{t.ndjson}</SelectItem>
                <SelectItem value="csv">{t.csv}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" disabled={action.busy}>
            {action.busy ? <Loader2 className="animate-spin" /> : <Download />}
            {action.busy ? t.downloading : t.download}
          </Button>
        </div>
        <ErrorBanner message={formError ?? action.error} />
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
          <li>{t.note1(EXPORT_MAX_DAYS)}</li>
          <li>{t.note2}</li>
          <li>{t.note3(settings.data?.archive_retention_days)}</li>
          <li>{t.note4}</li>
        </ul>
      </form>
    </Section>
  );
}
