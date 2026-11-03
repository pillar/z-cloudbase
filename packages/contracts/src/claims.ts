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
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

/** Console access token claims: same issuer/keys as product tokens, `aud` = CONSOLE_AUDIENCE, no pid/env. */
export const ConsoleTokenClaims = AccessTokenClaims.pick({
  iss: true, sub: true, aud: true, exp: true, iat: true, jti: true, sid: true, scope: true,
});
export type ConsoleTokenClaims = z.infer<typeof ConsoleTokenClaims>;
