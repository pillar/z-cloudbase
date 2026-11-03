import { ApiError } from '@z-cloudbase/contracts';
import { z } from 'zod';
import type { Auth } from './auth.ts';

const LinkEmailBody = z.object({
  email: z.email().max(254),
  // Same bounds as Better Auth's emailAndPassword defaults; checked before any write.
  password: z.string().min(8).max(128),
});

/**
 * Upgrade the current anonymous user to Email/Password without changing its id
 * (PRD §19.7). Better Auth's anonymous plugin only "links" by creating a new user on
 * sign-up, so the upgrade is composed from engine primitives: the email is attached to
 * the existing user row and the credential account is created by the engine's
 * `setPassword` (which also hashes the password). The `account.create.after` hook in
 * account-policy.ts flips `isAnonymous`. An email owned by another user is a conflict,
 * never a merge. D1 has no transactions: if creating the credential fails, the email
 * change is reverted so the anonymous user is left exactly as it was.
 */
export async function linkEmailPassword(auth: Auth, headers: Headers, body: unknown) {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new ApiError('unauthenticated', 'Sign in first');
  if (!session.user.isAnonymous) throw new ApiError('invalid_request', 'Only anonymous users can be upgraded here');
  const parsed = LinkEmailBody.safeParse(body);
  if (!parsed.success) throw new ApiError('validation_failed', 'Invalid email or password');
  const email = parsed.data.email.toLowerCase();

  const ctx = await auth.$context;
  const owner = await ctx.internalAdapter.findUserByEmail(email);
  if (owner && owner.user.id !== session.user.id) {
    throw new ApiError('identity_conflict', 'This credential already belongs to another account');
  }
  const previous = { email: session.user.email, emailVerified: session.user.emailVerified };
  try {
    await ctx.internalAdapter.updateUser(session.user.id, { email, emailVerified: false });
  } catch (e) {
    // Lost a race with another user claiming the same email (UNIQUE constraint).
    if (/unique/i.test(String(e))) throw new ApiError('identity_conflict', 'This credential already belongs to another account');
    throw e;
  }
  try {
    await auth.api.setPassword({ headers, body: { newPassword: parsed.data.password } });
  } catch (e) {
    await ctx.internalAdapter.updateUser(session.user.id, previous);
    throw e;
  }
  // Ownership of the new address is proven separately (PRD §4.2 item 2).
  await auth.api.sendVerificationEmail({ headers, body: { email } });
  return { user_id: session.user.id };
}
