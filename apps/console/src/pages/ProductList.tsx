import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { defineMessages, useFormat, useT } from '../i18n.tsx';
import { CopyText, EmptyState, ErrorBanner, Loading, PageHeader, StatusBadge, common, isOwner, useAction, useApp, useLoad } from '../ui.tsx';
import type { ProductSummary } from '../types.ts';

const messages = defineMessages({
  zh: {
    title: '产品',
    description: '你有权访问的所有产品。每个产品拥有独立的环境、密钥和数据。',
    newProduct: '新建产品',
    newDescription: '产品 ID 创建后不可修改。',
    productId: '产品 ID',
    productIdHelp: '创建后不可修改。小写字母开头，可含小写字母、数字和下划线（3–32 个字符）。',
    name: '名称',
    redirectUris: '重定向 URI',
    allowedOrigins: '允许的来源',
    onePerLine: '每行一个',
    createProduct: '创建产品',
    created: '创建于',
    empty: '没有可见的产品',
    emptyHint: '你还没有被授权访问任何产品。',
    createdOk: '产品已创建',
    open: '公开',
    restricted: '受限',
  },
  en: {
    title: 'Products',
    description: 'Every product you can access. Each product has its own environments, keys and data.',
    newProduct: 'New product',
    newDescription: 'The product ID cannot be changed after creation.',
    productId: 'Product ID',
    productIdHelp: 'Immutable. Starts with a lowercase letter; lowercase letters, digits and underscores (3–32 characters).',
    name: 'Name',
    redirectUris: 'Redirect URIs',
    allowedOrigins: 'Allowed origins',
    onePerLine: 'One per line',
    createProduct: 'Create product',
    created: 'Created',
    empty: 'No products visible to you',
    emptyHint: 'You have not been granted access to any product yet.',
    createdOk: 'Product created',
    open: 'Open',
    restricted: 'Restricted',
  },
});

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const EMPTY_FORM = { product_id: '', name: '', redirect_uris: '', allowed_origins: '' };

export function ProductList() {
  const { me } = useApp();
  const t = useT(messages);
  const f = useFormat();
  const list = useLoad((a) => a.get<{ products: ProductSummary[] }>('/products'), 'products');

  return (
    <div className="space-y-6">
      <PageHeader title={t.title} description={t.description} actions={isOwner(me) && <NewProduct onCreated={list.reload} />} />
      <ErrorBanner message={list.error} />
      <Loading loading={list.loading} rows={4} />
      {list.data && list.data.products.length === 0 && <EmptyState title={t.empty} description={t.emptyHint} />}
      {list.data && list.data.products.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.products.map((p) => (
            <a key={p.id} href={`#/p/${p.id}/settings`} className="focus-visible:ring-ring/50 block rounded-xl outline-none focus-visible:ring-[3px]">
              <Card className="hover:border-foreground/30 h-full transition-colors">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="min-w-0 truncate">{p.name}</CardTitle>
                    <StatusBadge status={p.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <CopyText value={p.id} />
                  <p className="text-muted-foreground text-sm">
                    {p.visibility === 'open' ? t.open : t.restricted} · {t.created} {f.time(p.created_at)}
                  </p>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function NewProduct({ onCreated }: { onCreated: () => void }) {
  const { api } = useApp();
  const t = useT(messages);
  const c = useT(common);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const create = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await create.run(() =>
      api.post('/products', {
        product_id: form.product_id,
        name: form.name,
        redirect_uris: lines(form.redirect_uris),
        allowed_origins: lines(form.allowed_origins),
      }),
    );
    if (ok) {
      setForm(EMPTY_FORM);
      setOpen(false);
      toast.success(t.createdOk);
      onCreated();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) create.clear();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus />
          {t.newProduct}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.newProduct}</DialogTitle>
          <DialogDescription>{t.newDescription}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="np-id">{t.productId}</Label>
            <Input id="np-id" required pattern="[a-z][a-z0-9_]{2,31}" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <p className="text-muted-foreground text-sm">{t.productIdHelp}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-name">{t.name}</Label>
            <Input id="np-name" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-redirects">{t.redirectUris}</Label>
            <Textarea id="np-redirects" rows={2} value={form.redirect_uris} onChange={(e) => setForm({ ...form, redirect_uris: e.target.value })} />
            <p className="text-muted-foreground text-sm">{t.onePerLine}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-origins">{t.allowedOrigins}</Label>
            <Textarea id="np-origins" rows={2} value={form.allowed_origins} onChange={(e) => setForm({ ...form, allowed_origins: e.target.value })} />
            <p className="text-muted-foreground text-sm">{t.onePerLine}</p>
          </div>
          <ErrorBanner message={create.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{c.cancel}</Button>
            <Button type="submit" disabled={create.busy}>
              {create.busy && <Loader2 className="animate-spin" />}
              {t.createProduct}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
