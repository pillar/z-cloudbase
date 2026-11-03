import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { BarChart3, Database, Gauge, History, KeyRound, ScrollText, Settings2, ShieldCheck, Users as UsersIcon, Webhook, type LucideIcon } from 'lucide-react';
import { defineMessages, useT } from '../i18n.tsx';
import { CopyText, ErrorBanner, Loading, StatusBadge, hasRole, useApp, useLoad } from '../ui.tsx';
import type { Me, ProductDetail as Product } from '../types.ts';

// Each section is its own chunk (recharts only loads with Analytics).
const lazyNamed = <K extends string>(load: () => Promise<Record<K, ComponentType<TabProps>>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Settings = lazyNamed(() => import('./Settings.tsx'), 'Settings');
const Environments = lazyNamed(() => import('./Environments.tsx'), 'Environments');
const Buckets = lazyNamed(() => import('./Buckets.tsx'), 'Buckets');
const Usage = lazyNamed(() => import('./Usage.tsx'), 'Usage');
const Logs = lazyNamed(() => import('./Logs.tsx'), 'Logs');
const Analytics = lazyNamed(() => import('./Analytics.tsx'), 'Analytics');
const Users = lazyNamed(() => import('./Users.tsx'), 'Users');
const Webhooks = lazyNamed(() => import('./Webhooks.tsx'), 'Webhooks');
const Team = lazyNamed(() => import('./Team.tsx'), 'Team');
const Audit = lazyNamed(() => import('./Audit.tsx'), 'Audit');

export interface TabProps {
  product: Product;
  reload: () => void;
}

export const sectionMessages = defineMessages({
  zh: {
    settings: '基本设置',
    environments: '环境与密钥',
    buckets: '存储桶',
    usage: '存储用量',
    logs: '日志',
    analytics: '数据分析',
    users: '用户',
    webhooks: 'Webhook',
    team: '团队成员',
    audit: '审计日志',
  },
  en: {
    settings: 'Settings',
    environments: 'Environments & keys',
    buckets: 'Buckets',
    usage: 'Storage usage',
    logs: 'Logs',
    analytics: 'Analytics',
    users: 'Users',
    webhooks: 'Webhooks',
    team: 'Team',
    audit: 'Audit log',
  },
});

export type SectionId = keyof (typeof sectionMessages)['zh'];

/** Product sections in navigation order. `admin` sections need product_admin (hint; the server enforces RBAC). */
export const SECTIONS: Array<{ id: SectionId; icon: LucideIcon; admin?: boolean; render: (p: TabProps) => ReactNode }> = [
  { id: 'settings', icon: Settings2, render: (p) => <Settings {...p} /> },
  { id: 'environments', icon: KeyRound, render: (p) => <Environments {...p} /> },
  { id: 'buckets', icon: Database, render: (p) => <Buckets {...p} /> },
  { id: 'usage', icon: Gauge, render: (p) => <Usage {...p} /> },
  { id: 'logs', icon: ScrollText, render: (p) => <Logs {...p} /> },
  { id: 'analytics', icon: BarChart3, render: (p) => <Analytics {...p} /> },
  { id: 'users', icon: UsersIcon, admin: true, render: (p) => <Users {...p} /> },
  { id: 'webhooks', icon: Webhook, render: (p) => <Webhooks {...p} /> },
  { id: 'team', icon: ShieldCheck, admin: true, render: (p) => <Team {...p} /> },
  { id: 'audit', icon: History, render: (p) => <Audit {...p} /> },
];

export const visibleSections = (me: Me, productId: string) => {
  const admin = hasRole(me, productId, 'product_admin');
  return SECTIONS.filter((s) => !s.admin || admin);
};

export function ProductDetail({ productId, tab }: { productId: string; tab: string }) {
  const { me } = useApp();
  const q = useLoad((a) => a.get<Product>(`/products/${encodeURIComponent(productId)}`), productId);
  const sections = visibleSections(me, productId);
  const active = sections.find((s) => s.id === tab) ?? sections[0]!;

  return (
    <div className="space-y-6">
      <ErrorBanner message={q.error} />
      <Loading loading={q.loading && !q.data} rows={4} />
      {q.data && (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b pb-4">
            <h1 className="text-2xl font-semibold tracking-tight">{q.data.name}</h1>
            <CopyText value={q.data.id} />
            <StatusBadge status={q.data.status} />
          </div>
          <div key={active.id} className="space-y-6">
            <Suspense fallback={<Loading loading rows={4} />}>{active.render({ product: q.data, reload: q.reload })}</Suspense>
          </div>
        </>
      )}
    </div>
  );
}

export const useSectionLabel = () => useT(sectionMessages);
