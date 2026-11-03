// Passkeys (PRD §21.3): Better Auth's passkey plugin (SimpleWebAuthn) with the relying party pinned to
// the issuer, user verification required on both ceremonies (so a passkey sign-in is multi-factor and
// counts for the console MFA requirement, src/mfa-policy.ts), audit events, and the small same-origin
// browser script that runs the WebAuthn ceremonies for the server-rendered pages.
import { passkey } from '@better-auth/passkey';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { writeAudit } from './audit.ts';

export const PASSKEY_SIGN_IN_PATH = '/passkey/verify-authentication';

const UV_REQUIRED = { code: 'USER_VERIFICATION_REQUIRED', message: 'The passkey must verify the user (biometrics or PIN)' } as const;

export function passkeyPlugin(o: { issuer: string; platformName: string }) {
  const url = new URL(o.issuer);
  return passkey({
    rpID: url.hostname,
    rpName: o.platformName,
    // Pinned: the plugin would otherwise trust the request's Origin header.
    origin: url.origin,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    registration: {
      afterVerification: async ({ verification }) => {
        if (!verification.registrationInfo?.userVerified) throw new APIError('BAD_REQUEST', UV_REQUIRED);
      },
    },
    authentication: {
      afterVerification: async ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) throw new APIError('UNAUTHORIZED', UV_REQUIRED);
      },
    },
  });
}

/** Anonymous users cannot add passkeys (not an upgrade path); adding / removing one is audited. */
export function passkeyPolicy(deps: { db: D1Database }) {
  const audit = (userId: string, action: string, passkeyId: unknown) =>
    writeAudit(deps.db, {
      actorType: 'user', actorId: userId, action, targetType: 'user', targetId: userId,
      metadata: typeof passkeyId === 'string' ? { passkey_id: passkeyId } : {},
    });
  return {
    id: 'z-cloudbase-passkey-policy',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if ((session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous) {
              throw new APIError('FORBIDDEN', { code: 'ANONYMOUS_PASSKEY', message: 'Guests cannot add a passkey; add an email or a provider first' });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/passkey/verify-registration' || ctx.path === '/passkey/delete-passkey',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!returned || isAPIError(returned) || (returned instanceof Response && !returned.ok)) return;
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            if (ctx.path === '/passkey/delete-passkey') return audit(session.user.id, 'auth.passkey_removed', ctx.body?.id);
            const body = returned instanceof Response ? await returned.clone().json().catch(() => null) : returned;
            await audit(session.user.id, 'auth.passkey_added', (body as { id?: unknown } | null)?.id);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/**
 * Browser side of the ceremonies, served as `/assets/passkey.js` (same origin, no third-party code).
 * `[data-passkey-signin]` buttons sign in (optionally continuing a signed authorization request from
 * `data-oauth-query`; afterwards the browser goes to the engine's continuation URL, or to
 * `/passkey/continue?return=…`, which only accepts this issuer's own targets). `[data-passkey-register]`
 * adds a passkey to the signed-in account and goes to `data-next` (a same-origin path).
 * User verification is requested as `required`; the server rejects assertions without it anyway.
 */
export const PASSKEY_SCRIPT = String.raw`(() => {
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bin = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const cred = (c) => ({ id: c.id, rawId: b64(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
    response: Object.fromEntries(Object.entries({
      clientDataJSON: c.response.clientDataJSON, attestationObject: c.response.attestationObject,
      authenticatorData: c.response.authenticatorData, signature: c.response.signature, userHandle: c.response.userHandle,
    }).filter(([, v]) => v).map(([k, v]) => [k, b64(v)]).concat(c.response.getTransports ? [['transports', c.response.getTransports()]] : [])) });
  const api = async (path, init) => {
    const res = await fetch('/api/auth' + path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, ...init });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.message) || ('HTTP ' + res.status));
    return body;
  };
  const fail = (btn, e) => {
    const out = document.querySelector(btn.dataset.error || '#passkey-error');
    if (out) { out.textContent = (btn.dataset.failed || 'Passkey failed') + ': ' + (e && e.message ? e.message : e); out.hidden = false; }
  };
  const support = typeof window.PublicKeyCredential === 'function';
  for (const btn of document.querySelectorAll('[data-passkey-signin],[data-passkey-register]')) {
    if (!support) { btn.disabled = true; continue; }
    btn.hidden = false;
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      try {
        if (btn.hasAttribute('data-passkey-signin')) {
          const o = await api('/passkey/generate-authenticate-options', { method: 'GET' });
          const publicKey = { ...o, challenge: bin(o.challenge), userVerification: 'required',
            allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: bin(c.id) })) };
          const c = await navigator.credentials.get({ publicKey });
          const q = btn.dataset.oauthQuery;
          const r = await api('/passkey/verify-authentication', { method: 'POST', body: JSON.stringify({ response: cred(c), ...(q ? { oauth_query: q } : {}) }) });
          location.assign(r && r.url ? r.url : '/passkey/continue?' + new URLSearchParams({ return: btn.dataset.return || '' }));
        } else {
          const o = await api('/passkey/generate-register-options', { method: 'GET' });
          const publicKey = { ...o, challenge: bin(o.challenge), user: { ...o.user, id: bin(o.user.id) },
            excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: bin(c.id) })) };
          const c = await navigator.credentials.create({ publicKey });
          await api('/passkey/verify-registration', { method: 'POST', body: JSON.stringify({ response: cred(c), name: btn.dataset.name || undefined }) });
          location.assign(btn.dataset.next && btn.dataset.next.startsWith('/') && !btn.dataset.next.startsWith('//') ? btn.dataset.next : '/account');
        }
      } catch (e) {
        fail(btn, e);
      } finally {
        btn.disabled = false;
      }
    });
  }
})();
`;
