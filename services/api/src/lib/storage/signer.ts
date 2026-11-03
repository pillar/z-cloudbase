import { ApiError } from '@z-cloudbase/contracts';
import { timingSafeEqual } from '@z-cloudbase/security';
import { AwsClient } from 'aws4fetch';

/** Issues short-lived URLs for direct-to-storage transfer (PRD §4.3). Object keys are always server-generated. */
export interface UrlSigner {
  signUpload(o: { key: string; contentType: string; size: number; expiresAt: number }): Promise<{ url: string; headers: Record<string, string> }>;
  signDownload(o: { key: string; expiresAt: number }): Promise<string>;
}

export function isLocalEnv(env: Env): boolean {
  const d: string = env.DEPLOY_ENV;
  return d === 'local' || d === 'test';
}

export function getSigner(env: Env): UrlSigner {
  return isLocalEnv(env) ? new LocalSigner(env) : new R2PresignSigner(env);
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

export interface LocalTokenPayload {
  /** R2 object key */
  k: string;
  /** HTTP method the token is valid for */
  m: 'PUT' | 'GET';
  /** expiry, epoch ms */
  e: number;
  /** upload only: signed content type and size */
  t?: string;
  s?: number;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/**
 * Local/test replacement for R2 presigning (Miniflare has no S3 endpoint, PRD §19.10): the URL points at
 * this Worker's own `/v1/storage/local/*` routes, which are served only when DEPLOY_ENV is local/test.
 * Token = base64url(payload) "." base64url(HMAC-SHA256(secret, base64url(payload))).
 */
export class LocalSigner implements UrlSigner {
  constructor(private readonly env: Env) {}

  private secret(): string {
    if (!this.env.UPLOAD_SIGNING_SECRET) throw new ApiError('unavailable', 'UPLOAD_SIGNING_SECRET is not configured');
    return this.env.UPLOAD_SIGNING_SECRET;
  }

  async token(p: LocalTokenPayload): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(p)));
    return `${body}.${b64url(await hmac(this.secret(), body))}`;
  }

  async signUpload(o: { key: string; contentType: string; size: number; expiresAt: number }) {
    const token = await this.token({ k: o.key, m: 'PUT', e: o.expiresAt, t: o.contentType, s: o.size });
    return { url: `${this.env.API_ORIGIN}/v1/storage/local/upload/${token}`, headers: { 'Content-Type': o.contentType } };
  }

  async signDownload(o: { key: string; expiresAt: number }) {
    return `${this.env.API_ORIGIN}/v1/storage/local/download/${await this.token({ k: o.key, m: 'GET', e: o.expiresAt })}`;
  }

  /** Returns the payload of a valid, unexpired token for `method`; any failure is `not_found` (no oracle). */
  async verify(token: string, method: 'PUT' | 'GET'): Promise<LocalTokenPayload> {
    const bad = new ApiError('not_found', 'Invalid or expired URL');
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) throw bad;
    if (!timingSafeEqual(b64url(await hmac(this.secret(), body)), sig)) throw bad;
    let p: LocalTokenPayload;
    try {
      p = JSON.parse(new TextDecoder().decode(unb64url(body))) as LocalTokenPayload;
    } catch {
      throw bad;
    }
    if (p.m !== method || typeof p.e !== 'number' || p.e <= Date.now()) throw bad;
    return p;
  }
}

/**
 * Production signer: S3-compatible presigned URLs against the R2 S3 endpoint via aws4fetch.
 * REMOTE UNVERIFIED: needs R2 API credentials and bucket CORS, neither available locally (PRD D10).
 */
export class R2PresignSigner implements UrlSigner {
  constructor(private readonly env: Env) {}

  private client() {
    const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET_NAME: bucket } = this.env;
    if (!account || !accessKeyId || !secretAccessKey || !bucket) throw new ApiError('unavailable', 'R2 presign credentials are not configured');
    return { aws: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }), base: `https://${account}.r2.cloudflarestorage.com/${bucket}` };
  }

  private async presign(method: 'PUT' | 'GET', key: string, expiresAt: number, headers: Record<string, string>, query: Record<string, string> = {}) {
    const { aws, base } = this.client();
    const url = new URL(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`);
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const signed = await aws.sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
    return signed.url;
  }

  async signUpload(o: { key: string; contentType: string; size: number; expiresAt: number }) {
    const headers = { 'Content-Type': o.contentType };
    return { url: await this.presign('PUT', o.key, o.expiresAt, headers), headers };
  }

  signDownload(o: { key: string; expiresAt: number }) {
    return this.presign('GET', o.key, o.expiresAt, {}, { 'response-content-disposition': 'attachment' });
  }
}
