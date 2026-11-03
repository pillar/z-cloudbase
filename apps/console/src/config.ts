import { CONSOLE_AUDIENCE, CONSOLE_CLIENT_ID } from '@z-cloudbase/contracts';

export interface Config {
  issuer: string;
  apiOrigin: string;
  clientId: string;
  resource: string;
  redirectUri: string;
}

/** `VITE_ISSUER` is the identity worker origin, `VITE_API_ORIGIN` the api worker origin. */
export function readConfig(vars: Record<string, string | undefined>, origin: string): Config {
  const issuer = vars.VITE_ISSUER?.replace(/\/$/, '');
  const apiOrigin = vars.VITE_API_ORIGIN?.replace(/\/$/, '');
  if (!issuer || !apiOrigin) throw new Error('VITE_ISSUER and VITE_API_ORIGIN must be set (see apps/console/env.example)');
  return { issuer, apiOrigin, clientId: CONSOLE_CLIENT_ID, resource: CONSOLE_AUDIENCE, redirectUri: `${origin}/` };
}
