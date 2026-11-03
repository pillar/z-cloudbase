import type { Environment, Role } from '@z-cloudbase/contracts';

// Console RBAC — PRD §2, §19.9. Server-side only; never trust UI hiding.

export type Action =
  | 'platform:manage'      // create products, manage platform team, platform-wide settings
  | 'product:read'
  | 'product:write'        // settings, status, redirect URIs
  | 'keys:manage'          // create / rotate / revoke service and publishable keys
  | 'team:manage'          // assign product admins / developers
  | 'users:read'           // look up users and memberships
  | 'users:manage'         // suspend / revoke membership, deletion requests
  | 'storage:read_meta'    // object metadata and usage, never file content
  | 'logs:read'
  | 'analytics:read'
  | 'analytics:export'     // raw event export (PRD §21.9); developers only outside prod, operators never
  | 'audit:read'
  // PRD §21.5 / §21.6 (v3.1)
  | 'users:ban'            // platform-wide ban / unban (owner only)
  | 'users:impersonate'    // support impersonation (owner only)
  | 'webhooks:read'        // product webhook endpoints and delivery log
  | 'webhooks:manage';     // create / change / delete / rotate / test webhook endpoints

export interface Grant {
  role: Role;
  /** null for platform-wide roles (owner, operator). */
  productId: string | null;
}

export interface Target {
  productId?: string;
  env?: Environment;
}

const OPERATOR_ACTIONS: ReadonlySet<Action> = new Set([
  'product:read', 'storage:read_meta', 'logs:read', 'analytics:read', 'audit:read', 'webhooks:read',
]);
const PRODUCT_ADMIN_ACTIONS: ReadonlySet<Action> = new Set([
  'product:read', 'product:write', 'keys:manage', 'team:manage', 'users:read', 'users:manage',
  'storage:read_meta', 'logs:read', 'analytics:read', 'analytics:export', 'audit:read', 'webhooks:read', 'webhooks:manage',
]);
const DEVELOPER_ACTIONS: ReadonlySet<Action> = new Set([
  'product:read', 'keys:manage', 'storage:read_meta', 'logs:read', 'analytics:read', 'analytics:export', 'webhooks:read', 'webhooks:manage',
]);

function grantAllows(g: Grant, action: Action, target: Target): boolean {
  switch (g.role) {
    case 'owner':
      return true;
    case 'operator':
      return OPERATOR_ACTIONS.has(action);
    case 'product_admin':
      return target.productId !== undefined && g.productId === target.productId && PRODUCT_ADMIN_ACTIONS.has(action);
    case 'product_developer':
      if (target.productId === undefined || g.productId !== target.productId || !DEVELOPER_ACTIONS.has(action)) return false;
      // Developers never touch production secrets (PRD §2), webhook signing secrets included (§21.6), nor export prod events (§21.9).
      if (action === 'keys:manage' || action === 'analytics:export' || action === 'webhooks:manage') return target.env !== undefined && target.env !== 'prod';
      return true;
  }
}

export function can(grants: readonly Grant[], action: Action, target: Target = {}): boolean {
  return grants.some((g) => grantAllows(g, action, target));
}

/** Product ids a principal may list; `'all'` for platform-wide roles. */
export function visibleProducts(grants: readonly Grant[]): 'all' | string[] {
  if (grants.some((g) => g.role === 'owner' || g.role === 'operator')) return 'all';
  return [...new Set(grants.flatMap((g) => (g.productId ? [g.productId] : [])))];
}
