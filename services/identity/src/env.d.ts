// Optional secrets not covered by `wrangler types` (only AUTH_SECRET is required).
interface Env {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  /** Apple client secret JWT (ES256, signed with the team key); rotated outside this worker. */
  APPLE_CLIENT_SECRET?: string;
  /** Turnstile siteverify secret; required outside DEPLOY_ENV=local once a challenge is due (src/turnstile.ts). */
  TURNSTILE_SECRET_KEY?: string;
  /** Resend API key (D13); with EMAIL_FROM, deployments send mail through Resend (src/email.ts). */
  RESEND_API_KEY?: string;
}

// workerd implements node:async_hooks under nodejs_compat; declare only what we use
// instead of pulling @types/node into a Workers project.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
