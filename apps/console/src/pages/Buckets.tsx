import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ENVIRONMENTS, type Environment } from '@z-cloudbase/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import { EmptyState, EnvSelect, ErrorBanner, Loading, Section, common, hasRole, useAction, useApp, useLoad } from '../ui.tsx';
import type { Bucket, EventSchema } from '../types.ts';
import { EXAMPLE_EVENT_SCHEMA, buildEventSchemaRequest } from '../envSettings.ts';
import type { TabProps } from './ProductDetail.tsx';

const messages = defineMessages({
  zh: {
    bucketsTitle: '存储桶',
    bucketsDescription: '该环境下用于文件存储的 bucket。',
    addBucket: '新建存储桶',
    addBucketDescription: '名称以小写字母开头，只能包含小写字母、数字和连字符，长度 2–63。',
    bucketName: '名称',
    visibility: '可见性',
    private: '私有',
    public: '公开',
    created: '创建时间',
    noBuckets: '还没有存储桶',
    bucketCreated: '存储桶已创建',
    schemasTitle: '事件 Schema',
    schemasDescription: '为分析事件注册属性约束。',
    registerSchema: '注册 Schema',
    registerSchemaDescription: '开发 / 预发布环境中违反 Schema 只会告警，生产环境会直接拒绝。',
    eventName: '事件名',
    version: '版本',
    properties: '属性',
    propertySchema: '属性 Schema（JSON）',
    schemaHint: '支持标量类型 string / number / boolean / null（或其列表）、required、max_length、enum、minimum、maximum；additional_properties 为 false 时拒绝未列出的字段。',
    noSchemas: '还没有注册事件 Schema',
    noProperties: '无属性',
    legacySchema: '旧版 Schema',
    schemaRegistered: 'Schema 已注册',
  },
  en: {
    bucketsTitle: 'Storage buckets',
    bucketsDescription: 'Buckets used for file storage in this environment.',
    addBucket: 'New bucket',
    addBucketDescription: 'Starts with a lowercase letter; lowercase letters, digits and hyphens only, 2–63 characters.',
    bucketName: 'Name',
    visibility: 'Visibility',
    private: 'Private',
    public: 'Public',
    created: 'Created',
    noBuckets: 'No buckets yet',
    bucketCreated: 'Bucket created',
    schemasTitle: 'Event schemas',
    schemasDescription: 'Register property constraints for analytics events.',
    registerSchema: 'Register schema',
    registerSchemaDescription: 'Violations only warn in dev / staging and are rejected in prod.',
    eventName: 'Event name',
    version: 'Version',
    properties: 'Properties',
    propertySchema: 'Property schema (JSON)',
    schemaHint: 'Scalar types string / number / boolean / null (or a list of them), required, max_length, enum, minimum, maximum; additional_properties false rejects unlisted fields.',
    noSchemas: 'No event schemas registered yet',
    noProperties: 'no properties',
    legacySchema: 'legacy schema',
    schemaRegistered: 'Schema registered',
  },
});

const schemaProperties = (schema: unknown): string[] | null => {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  return props ? Object.keys(props) : null;
};

export function Buckets({ product }: TabProps) {
  const { api, me } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const f = useFormat();
  const [env, setEnv] = useState<Environment>(ENVIRONMENTS[0]);
  const base = `/products/${product.id}/environments/${env}`;
  const buckets = useLoad((a) => a.get<{ buckets: Bucket[] }>(`${base}/buckets`), base);
  const schemas = useLoad((a) => a.get<{ event_schemas: EventSchema[] }>(`${base}/event-schemas`), base);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [evt, setEvt] = useState({ event_name: '', schema_version: '1', schema: EXAMPLE_EVENT_SCHEMA });
  const [schemaError, setSchemaError] = useState<string>();
  const [bucketOpen, setBucketOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const addBucket = useAction();
  const addSchema = useAction();
  const canWrite = hasRole(me, product.id, 'product_admin');

  async function submitBucket(e: React.FormEvent) {
    e.preventDefault();
    if (await addBucket.run(() => api.post(`${base}/buckets`, { name, visibility }))) {
      setName('');
      setBucketOpen(false);
      toast.success(t.bucketCreated);
      buckets.reload();
    }
  }
  async function submitSchema(e: React.FormEvent) {
    e.preventDefault();
    const built = buildEventSchemaRequest(evt.event_name, evt.schema_version, evt.schema);
    setSchemaError(built.ok ? undefined : built.error);
    if (!built.ok) return;
    const ok = await addSchema.run(() => api.post(`${base}/event-schemas`, built.value));
    if (ok) {
      setEvt({ ...evt, event_name: '' });
      setSchemaOpen(false);
      toast.success(t.schemaRegistered);
      schemas.reload();
    }
  }

  const bucketAction = canWrite && (
    <Dialog
      open={bucketOpen}
      onOpenChange={(open) => {
        setBucketOpen(open);
        addBucket.clear();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          {t.addBucket}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submitBucket} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t.addBucket}</DialogTitle>
            <DialogDescription>{t.addBucketDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bucket-name">{t.bucketName}</Label>
            <Input id="bucket-name" required placeholder="bucket-name" pattern="[a-z][a-z0-9\-]{1,62}" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bucket-visibility">{t.visibility}</Label>
            <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)}>
              <SelectTrigger id="bucket-visibility" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">{t.private}</SelectItem>
                <SelectItem value="public">{t.public}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ErrorBanner message={addBucket.error} />
          <DialogFooter>
            <Button type="submit" disabled={addBucket.busy}>
              {addBucket.busy && <Loader2 className="animate-spin" />}
              {c.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  const schemaAction = canWrite && (
    <Dialog
      open={schemaOpen}
      onOpenChange={(open) => {
        setSchemaOpen(open);
        setSchemaError(undefined);
        addSchema.clear();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          {t.registerSchema}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submitSchema} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t.registerSchema}</DialogTitle>
            <DialogDescription>{t.registerSchemaDescription}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-2">
              <Label htmlFor="evt-name">{t.eventName}</Label>
              <Input id="evt-name" required pattern="[a-z][a-z0-9_]{0,63}" className="font-mono" value={evt.event_name} onChange={(e) => setEvt({ ...evt, event_name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="evt-version">{t.version}</Label>
              <Input id="evt-version" type="number" min={1} value={evt.schema_version} onChange={(e) => setEvt({ ...evt, schema_version: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="evt-schema">{t.propertySchema}</Label>
            <Textarea id="evt-schema" rows={10} className="font-mono text-xs" value={evt.schema} onChange={(e) => setEvt({ ...evt, schema: e.target.value })} />
            <p className="text-muted-foreground text-xs">{t.schemaHint}</p>
          </div>
          <ErrorBanner message={schemaError ?? addSchema.error} />
          <DialogFooter>
            <Button type="submit" disabled={addSchema.busy}>
              {addSchema.busy && <Loader2 className="animate-spin" />}
              {t.registerSchema}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <EnvSelect labelled value={env} onChange={setEnv} />
      </div>

      <Section title={t.bucketsTitle} description={t.bucketsDescription} action={bucketAction || undefined}>
        <ErrorBanner message={buckets.error} />
        <Loading loading={buckets.loading} />
        {buckets.data && buckets.data.buckets.length === 0 && <EmptyState title={t.noBuckets} />}
        {buckets.data && buckets.data.buckets.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.bucketName}</TableHead>
                  <TableHead>{t.visibility}</TableHead>
                  <TableHead>{t.created}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.data.buckets.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.name}</TableCell>
                    <TableCell>
                      <Badge variant={b.visibility === 'public' ? 'outline' : 'secondary'}>{b.visibility === 'public' ? t.public : t.private}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.time(b.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title={t.schemasTitle} description={t.schemasDescription} action={schemaAction || undefined}>
        <ErrorBanner message={schemas.error} />
        <Loading loading={schemas.loading} />
        {schemas.data && schemas.data.event_schemas.length === 0 && <EmptyState title={t.noSchemas} />}
        {schemas.data && schemas.data.event_schemas.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.eventName}</TableHead>
                  <TableHead>{t.version}</TableHead>
                  <TableHead>{t.properties}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schemas.data.event_schemas.map((s) => {
                  const props = schemaProperties(s.schema);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.event_name}</TableCell>
                      <TableCell>v{s.schema_version}</TableCell>
                      <TableCell className="whitespace-normal">
                        {props === null ? (
                          <span className="text-muted-foreground">{t.legacySchema}</span>
                        ) : props.length === 0 ? (
                          <span className="text-muted-foreground">{t.noProperties}</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {props.map((p) => <Badge key={p} variant="secondary" className="font-mono text-xs font-normal">{p}</Badge>)}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </>
  );
}
