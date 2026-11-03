// Secrets are not in wrangler.jsonc, so `wrangler types` does not know them. See .dev.vars.example.
export {};

declare global {
  interface Env {
    /** HMAC secret of LocalSigner (local/test only). */
    UPLOAD_SIGNING_SECRET?: string;
    /** R2 S3-API credentials of R2PresignSigner (production). */
    R2_ACCOUNT_ID?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    R2_BUCKET_NAME?: string;
  }
}
