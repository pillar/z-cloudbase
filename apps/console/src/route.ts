// Hash routes: `#/` products, `#/p/<id>[/<section>][?env=<env>]` a product, `#/<platform page>`.
import { isEnvironment, type Environment } from '@z-cloudbase/contracts';

/** Platform-level pages outside any product (`#/<page>`). */
export type PlatformPage = 'invitations';

export interface Route {
  productId?: string;
  section?: string;
  /** Environment named in a product URL (`?env=`); ignored when not a known environment. */
  env?: Environment;
  platformPage?: PlatformPage;
}

export function parseHash(hash: string): Route {
  const m = /^#\/p\/([^/?]+)(?:\/([^/?]+))?[^?]*(?:\?(.*))?/.exec(hash);
  if (m) {
    const env = new URLSearchParams(m[3] ?? '').get('env');
    return {
      productId: decodeURIComponent(m[1]!),
      ...(m[2] ? { section: m[2] } : {}),
      ...(isEnvironment(env) ? { env } : {}),
    };
  }
  const platform = /^#\/(invitations)$/.exec(hash);
  return platform ? { platformPage: platform[1] as PlatformPage } : {};
}
