import {
  ApiError, USER_PROPERTIES_MAX_BYTES, USER_PROPERTIES_MAX_KEYS, USER_PROPERTY_VALUE_MAX_CHARS, UserPropertiesRequest,
} from '@z-cloudbase/contracts';
import { userKey } from '@z-cloudbase/security';
import type { Context } from 'hono';
import type { AppEnv } from '../../context.ts';
import { readBatchBody } from '../../lib/ingest/body.ts';
import { activeMembers } from '../../lib/events/ingest.ts';

type Scalar = string | number | boolean | null;

/**
 * Merge product-scoped user properties (PRD §21.7): RFC 7396 semantics (null deletes a key). The user is the
 * token's user for publishable keys, or `user_id` (active member of this product) for service keys.
 */
export async function userPropertiesRoute(c: Context<AppEnv>) {
  const cred = c.get('cred');
  const parsed = UserPropertiesRequest.safeParse(await readBatchBody(c.req.raw, 16 * 1024));
  if (!parsed.success) {
    throw new ApiError('validation_failed', 'Body must be {"properties": {...}} with scalar values', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const body = parsed.data;
  let userId: string;
  if (cred.kind === 'service') {
    if (!body.user_id) throw new ApiError('validation_failed', 'user_id is required with a service key');
    if (!(await activeMembers(c.env.DB, cred.productId, [body.user_id])).has(body.user_id)) {
      throw new ApiError('membership_required', 'user_id has no active membership in this product');
    }
    userId = body.user_id;
  } else {
    if (body.user_id !== undefined) throw new ApiError('validation_failed', 'user_id is accepted only with a service key');
    const user = c.get('user');
    if (!user) throw new ApiError('unauthenticated', 'User properties need a signed-in user');
    userId = user.userId;
  }
  for (const [k, v] of Object.entries(body.properties)) {
    if (typeof v === 'string' && v.length > USER_PROPERTY_VALUE_MAX_CHARS) {
      throw new ApiError('validation_failed', `${k}: longer than ${USER_PROPERTY_VALUE_MAX_CHARS} characters`);
    }
  }

  const key = await userKey(userId, cred.userKeySalt);
  const row = await c.env.INGEST_DB.prepare('SELECT properties FROM user_properties WHERE product_env_id = ? AND user_key = ?')
    .bind(cred.productEnvId, key).first<{ properties: string }>();
  const merged: Record<string, Scalar> = row ? (JSON.parse(row.properties) as Record<string, Scalar>) : {};
  for (const [k, v] of Object.entries(body.properties)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const json = JSON.stringify(merged);
  if (Object.keys(merged).length > USER_PROPERTIES_MAX_KEYS || new TextEncoder().encode(json).length > USER_PROPERTIES_MAX_BYTES) {
    throw new ApiError('payload_too_large', `User properties are limited to ${USER_PROPERTIES_MAX_KEYS} keys and ${USER_PROPERTIES_MAX_BYTES} bytes`);
  }
  const now = Date.now();
  if (Object.keys(merged).length === 0) {
    await c.env.INGEST_DB.prepare('DELETE FROM user_properties WHERE product_env_id = ? AND user_key = ?').bind(cred.productEnvId, key).run();
  } else {
    await c.env.INGEST_DB.prepare(
      `INSERT INTO user_properties (product_env_id, user_key, properties, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (product_env_id, user_key) DO UPDATE SET properties = excluded.properties, updated_at = excluded.updated_at`,
    ).bind(cred.productEnvId, key, json, now).run();
  }
  return c.json({ properties: merged });
}
