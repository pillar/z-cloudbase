import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createApiClient } from './api.ts';
import { clearSession, completeLoginIfCallback, getAccessToken, hasSession, startLogin } from './auth.ts';
import { PLATFORM_NAME } from './brand.ts';
import { BrandMark } from './brand-mark.tsx';
import { readConfig } from './config.ts';
import { defineMessages, useT } from './i18n.tsx';
import { Invitations } from './pages/Invitations.tsx';
import { ProductDetail } from './pages/ProductDetail.tsx';
import { ProductList } from './pages/ProductList.tsx';
import { Shell, type PlatformPage, type Route } from './shell.tsx';
import type { Me } from './types.ts';
import { AppContext, ErrorBanner, errorText } from './ui.tsx';

const config = (() => {
  try {
    return readConfig(import.meta.env as Record<string, string | undefined>, location.origin);
  } catch (e) {
    return e as Error;
  }
})();

const messages = defineMessages({
  zh: {
    signingIn: '正在登录…',
    cannotOpen: '无法打开控制台',
    notMember: '只有平台团队成员可以使用控制台。如果你认为这是错误，请联系平台所有者。',
    signInAgain: '重新登录',
  },
  en: {
    signingIn: 'Signing in…',
    cannotOpen: 'Cannot open the console',
    notMember: 'Only members of the platform team can use the console. Ask a platform owner if you think this is wrong.',
    signInAgain: 'Sign in again',
  },
});

/** `#/` → products, `#/p/<id>[/<section>]` → product, `#/<platform page>` (e.g. `#/invitations`). */
function useHashRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const m = /^#\/p\/([^/]+)(?:\/([^/]+))?/.exec(hash);
  if (m) return { productId: decodeURIComponent(m[1]!), ...(m[2] ? { section: m[2] } : {}) };
  const platform = /^#\/(invitations)$/.exec(hash);
  return platform ? { platformPage: platform[1] as PlatformPage } : {};
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2 font-semibold">
        <BrandMark className="size-7 rounded-md" />
        {PLATFORM_NAME}
      </div>
      {children}
    </div>
  );
}

export function App() {
  const t = useT(messages);
  const route = useHashRoute();
  const [state, setState] = useState<{ phase: 'booting' } | { phase: 'error'; message: string } | { phase: 'ready'; me: Me }>({ phase: 'booting' });

  const api = useMemo(
    () =>
      config instanceof Error
        ? null
        : createApiClient({
            origin: config.apiOrigin,
            getToken: () => getAccessToken(config),
            onUnauthorized: () => {
              clearSession();
              void startLogin(config);
            },
          }),
    [],
  );

  useEffect(() => {
    if (config instanceof Error || !api) return;
    (async () => {
      await completeLoginIfCallback(config);
      if (!hasSession()) return void (await startLogin(config)); // leaves the page
      setState({ phase: 'ready', me: await api.get<Me>('/me') });
    })().catch((e) => setState({ phase: 'error', message: errorText(e) }));
  }, [api]);

  if (config instanceof Error || state.phase === 'error') {
    return (
      <Centered>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t.cannotOpen}</CardTitle>
            <CardDescription>{t.notMember}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ErrorBanner message={config instanceof Error ? config.message : state.phase === 'error' ? state.message : undefined} />
            {!(config instanceof Error) && <Button className="w-full" onClick={() => void startLogin(config)}>{t.signInAgain}</Button>}
          </CardContent>
        </Card>
      </Centered>
    );
  }
  if (state.phase === 'booting' || !api) {
    return (
      <Centered>
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t.signingIn}
        </p>
      </Centered>
    );
  }

  const signOut = () => {
    clearSession();
    location.assign(location.origin + '/');
  };
  return (
    <AppContext.Provider value={{ api, me: state.me }}>
      <Shell route={route} onSignOut={signOut}>
        {route.productId ? (
          <ProductDetail productId={route.productId} tab={route.section ?? 'settings'} />
        ) : route.platformPage === 'invitations' ? (
          <Invitations />
        ) : (
          <ProductList />
        )}
      </Shell>
    </AppContext.Provider>
  );
}
