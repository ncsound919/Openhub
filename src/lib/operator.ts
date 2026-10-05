import type { Request, Response, NextFunction } from 'express';

/**
 * Operator role gate for the highest-risk surfaces: the interactive shell, the
 * package-remediation route, closed-loop repair triggers, and API Studio's
 * request executor. Every route today only requires a valid access token, so
 * any authenticated user can run code as the server user.
 *
 * The gate is opt-in via `OPENHUB_ADMIN_ROLES` (comma/space separated). When it
 * is unset the surfaces behave as before (any authenticated user) so a local
 * single-user install is not locked out — but the server logs a startup warning
 * so the exposure is never silent. When it is set, the caller's role (from the
 * verified token, authoritative value read from the user record for the shell)
 * must be in the list. `*` allows any authenticated user (same as unset).
 */

/** Parsed operator role list. Empty array = gate disabled. `['*']` = allow any. */
export function configuredOperatorRoles(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OPENHUB_ADMIN_ROLES;
  if (!raw || !raw.trim()) return [];
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** True when `role` may exercise an operator surface given `roles`. */
export function isOperator(role: string | undefined | null, roles: string[]): boolean {
  if (roles.length === 0 || roles.includes('*')) return true;
  return typeof role === 'string' && role.trim() !== '' && roles.includes(role.trim());
}

/** The role carried on the authenticated request, if any. */
export function requestRole(req: Request): string | undefined {
  const role = (req as unknown as { user?: { role?: unknown } }).user?.role;
  return typeof role === 'string' && role.trim() ? role : undefined;
}

/** Express middleware enforcing the operator gate on one route. */
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (isOperator(requestRole(req), configuredOperatorRoles())) return next();
  res.status(403).json({ error: 'This action requires an operator role' });
}

/** A one-line boot warning when the gate is disabled, or null when configured. */
export function operatorGateWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (configuredOperatorRoles(env).length > 0) return null;
  return '[Server] WARNING: OPENHUB_ADMIN_ROLES is not set — the shell, remediation, '
    + 'repair and API-execution surfaces accept ANY authenticated user. '
    + 'Set OPENHUB_ADMIN_ROLES=owner,admin (or a wildcard `*`) to restrict them.';
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Router-level operator gate: applies `requireOperator` to mutating requests
 * whose path matches one of `patterns`. Use after the router's auth
 * middleware. Patterns are matched case-insensitively because Express routing
 * is case-insensitive by default — `/API/Pipeline/run` reaches the same
 * handler as `/api/pipeline/run`, so the gate must see it the same way.
 */
export function operatorGateFor(patterns: RegExp[]) {
  const res = patterns.map((re) => (re.flags.includes('i') ? re : new RegExp(re.source, `${re.flags}i`)));
  return (req: Request, resp: Response, next: NextFunction): void => {
    if (!MUTATING.has(String(req.method).toUpperCase())) return next();
    const p = req.path || '/';
    if (!res.some((re) => re.test(p))) return next();
    requireOperator(req, resp, next);
  };
}
