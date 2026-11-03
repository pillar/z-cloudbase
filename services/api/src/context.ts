import type { Environment, ServiceScope } from '@z-cloudbase/contracts';
import type { Grant, RequestIdVars } from '@z-cloudbase/security';

/** Product/env context derived from the `X-Platform-Key` credential — never from the body. */
export interface Credential {
  kind: 'publishable' | 'service';
  productId: string;
  env: Environment;
  /** `{product_id}.{env}` = OIDC client_id = product_environments.id */
  productEnvId: string;
  /** Empty for publishable keys. */
  scopes: ServiceScope[];
  /** service_credentials.id; null for publishable keys. */
  credentialId: string | null;
  userKeySalt: string;
}

/** End user from a verified product access token with an active membership. */
export interface UserContext {
  userId: string;
  anon: boolean;
  sessionId: string;
}

/** Console principal from a verified console token, with RBAC grants from team_members. */
export interface AdminContext {
  userId: string;
  grants: Grant[];
}

export type ApiVariables = RequestIdVars & {
  cred: Credential;
  user: UserContext | undefined;
  admin: AdminContext;
};

export type AppEnv = { Bindings: Env; Variables: ApiVariables };
