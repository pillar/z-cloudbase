// Test-side software WebAuthn authenticator (ES256, "none" attestation): builds the registration and
// assertion responses a browser would send for passkeys (PRD §21.3), so the engine's verification
// (SimpleWebAuthn) runs for real in workerd. It is not a conformance-tested authenticator; flags
// (user presence / verification), origin and counter are under the test's control.

const enc = new TextEncoder();
export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// --- minimal CBOR (RFC 8949) encoder: unsigned / negative ints, byte and text strings, maps ---
function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return concat(new Uint8Array([(major << 5) | 26]), u32(n));
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = enc.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  return concat(head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)]));
}

/** IEEE P1363 (r || s) → ASN.1 DER ECDSA signature, as WebAuthn expects. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

interface Credential {
  id: Uint8Array;
  keys: CryptoKeyPair;
  userHandle: string;
  counter: number;
}

export interface CeremonyOptions {
  /** User verification flag (biometrics / PIN); default true. */
  uv?: boolean;
  /** Origin written into clientDataJSON; default the authenticator's origin. */
  origin?: string;
}

export class SoftAuthenticator {
  readonly credentials: Credential[] = [];
  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {}

  private async authData(flags: number, counter: number, attested?: Uint8Array) {
    return concat(await sha256(enc.encode(this.rpId)), new Uint8Array([flags]), u32(counter), attested ?? new Uint8Array());
  }

  /** navigator.credentials.create() for the server's registration options (JSON). */
  async create(options: { challenge: string; user: { id: string } }, o: CeremonyOptions = {}) {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
    const id = crypto.getRandomValues(new Uint8Array(16));
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]));
    const attested = concat(new Uint8Array(16), new Uint8Array([0, id.length]), id, cose);
    const flags = 0x01 | (o.uv === false ? 0 : 0x04) | 0x40;
    const authData = await this.authData(flags, 0, attested);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.credentials.push({ id, keys, userHandle: options.user.id, counter: 0 });
    return {
      id: b64url(id), rawId: b64url(id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
    };
  }

  /** navigator.credentials.get() with the newest (or the given) credential. */
  async get(options: { challenge: string }, o: CeremonyOptions & { credential?: Credential } = {}) {
    const cred = o.credential ?? this.credentials.at(-1);
    if (!cred) throw new Error('no credential');
    cred.counter += 1;
    const authData = await this.authData(0x01 | (o.uv === false ? 0 : 0x04), cred.counter);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.keys.privateKey, signed));
    return {
      id: b64url(cred.id), rawId: b64url(cred.id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(derSignature(raw)),
        userHandle: cred.userHandle,
      },
    };
  }
}
