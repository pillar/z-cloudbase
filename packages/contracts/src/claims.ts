import { z } from 'zod';
import { ENVIRONMENTS, PRODUCT_ID_RE } from './ids.ts';

/** Access token claims — PRD §19.4. No PII in tokens. */
export const AccessTokenClaims = z.object({
  iss: z.string(),
  sub: z.string().startsWith('usr_'),
  /** `productAudience(client_id)`, optionally plus `userinfoAudience(iss)`. */
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string(),
  sid: z.string(),
  pid: z.string().regex(PRODUCT_ID_RE),
  env: z.enum(ENVIRONMENTS),
  anon: z.boolean(),
  scope: z.string(),
  /**
   * RFC 8693 actor: present only on tokens issued during an impersonation (PRD §21.5.2); `sub` is the
   * platform owner acting as this user. Products that must not accept support sessions reject such tokens.
   */
  act: z.object({ sub: z.string().startsWith('usr_') }).optional(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

/** Console access token claims: same issuer/keys as product tokens, `aud` = CONSOLE_AUDIENCE, no pid/env. */
export const ConsoleTokenClaims = AccessTokenClaims.pick({
  iss: true, sub: true, aud: true, exp: true, iat: true, jti: true, sid: true, scope: true, act: true,
});
export type ConsoleTokenClaims = z.infer<typeof ConsoleTokenClaims>;
