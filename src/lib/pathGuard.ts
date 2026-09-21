import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Canonicalize `p`: resolve symlinks/junctions on the deepest EXISTING ancestor,
 * then reattach the not-yet-existing tail.
 *
 * Why the ancestor walk rather than a plain `realpathSync`: the guard has to
 * answer for paths that do not exist yet (a file about to be written), and
 * `realpathSync` throws on those. Walking up to the deepest real ancestor gives
 * the actual on-disk location of everything that IS real, which is the part a
 * symlink can lie about.
 */
export function realCanonical(p: string): string {
  const norm = (s: string): string => path.normalize(s).replace(/\\/g, '/');
  let probe = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return norm(path.join(fs.realpathSync.native(probe), ...tail));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return norm(path.resolve(p)); // reached a filesystem root
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * True when `target` is `base` itself or a genuine descendant of it.
 *
 * Both sides are canonicalized through their real on-disk location first, so a
 * symlink or Windows junction planted INSIDE the base that points outside it is
 * rejected. A purely lexical check (`path.relative` on resolved-but-not-realpathed
 * paths) passes such a link: `repo/docs -> /etc` reads and writes /etc while every
 * `..` test says the path is contained. Anyone who can add a file to a repo — a
 * clone, an import, a push — can plant one.
 *
 * The comparison is also not a string prefix: `/repos/a/repo` must not contain
 * `/repos/a/repo-evil`.
 */
export function isSubpath(base: string, target: string): boolean {
  const canonBase = realCanonical(base);
  const canonTarget = realCanonical(target);
  return canonTarget === canonBase || canonTarget.startsWith(canonBase + '/');
}

/**
 * Path segments that must never be reachable through a repo-contents API.
 *
 * `.git` is the important one: a write under it is remote code execution, not
 * a file edit. Dropping `.git/hooks/post-commit` (or `pre-push`, or a `core.
 * fsmonitor` entry in `.git/config`) gets that script run by the server the
 * next time it touches the repo — and the server does touch it, via `git init`
 * and the GitHub push-sync path. A read is nearly as bad: `.git/config` holds
 * the remote URL, which is where a push token ends up.
 */
const DENIED_SEGMENTS = new Set(['.git']);

function namesDeniedSegment(p: string): boolean {
  return String(p ?? '')
    .split(/[\\/]+/)
    .some((seg) => DENIED_SEGMENTS.has(seg.trim().toLowerCase()));
}

/**
 * True when `relPath` (a repo-relative path) reaches a denied segment. Matching
 * is on normalized, separator-split segments and is case-insensitive, because
 * Windows and macOS will happily open `.GIT/HOOKS/POST-COMMIT`.
 *
 * Pass `base` (the repo root) to also judge where the path actually LANDS. A
 * name check alone is defeated by one symlink: `docs -> .git` spells no denied
 * segment, and writing `docs/hooks/post-commit` through it is the same remote
 * code execution the check exists to stop.
 */
export function hasDeniedSegment(relPath: string, base?: string): boolean {
  if (namesDeniedSegment(relPath)) return true;
  if (!base) return false;
  const canonBase = realCanonical(base);
  const canonTarget = realCanonical(path.join(base, relPath));
  return namesDeniedSegment(path.relative(canonBase, canonTarget));
}

/**
 * Roots the server-side folder browser and the local-folder import are allowed
 * to touch.
 *
 * Both endpoints used to accept `path.resolve(anything)`: any account that
 * could log in — including one auto-provisioned by SCIM or created on first SSO
 * login — could enumerate the whole host filesystem and register `/etc` or
 * another user's home as a "repository". A loopback bind is a deployment
 * detail, not an authorization boundary, and OpenHub ships an IdP integration,
 * so "everyone who can log in is the machine's owner" is not a safe assumption.
 *
 * Default: the server user's home directory, which keeps the single-operator
 * local workflow working. Set `OPENHUB_BROWSE_ROOTS` (path-separator delimited)
 * to narrow or widen it deliberately.
 */
export function browseRoots(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string[] {
  const raw = String(env.OPENHUB_BROWSE_ROOTS ?? '').trim();
  const roots = raw
    ? raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean)
    : [homeDir];
  return roots.map((r) => path.resolve(r));
}

/**
 * Directory names never exposed through the browser, even inside an allowed
 * root. These hold credentials, not projects, and listing them is the first
 * step of taking them.
 */
const SENSITIVE_DIRS = new Set([
  '.ssh', '.aws', '.gnupg', '.gpg', '.kube', '.docker', '.azure',
  '.npmrc', '.netrc', '.password-store', '.keychains', '.gh', '.git-credentials',
]);

/** Credential stores that span more than one path segment. A segment-by-segment
 *  check can never match these (`.config/gcloud` is one entry, not two), so a
 *  multi-segment entry silently disabled itself — `~/.config/gcloud/application_
 *  default_credentials.json` stayed browsable. Matched against the normalized
 *  full path instead. */
const SENSITIVE_PATHS = ['.config/gcloud'];

/** True when any segment of `target` — as written OR as it resolves on disk —
 *  names a credential store. The canonical form matters: a directory symlinked
 *  to `~/.ssh` under an innocuous name is exactly how this filter gets walked
 *  around. */
export function touchesSensitiveDir(target: string): boolean {
  const names = (p: string): boolean => p
    .split(/[\\/]+/)
    .some((seg) => SENSITIVE_DIRS.has(seg.trim().toLowerCase()));
  const matchesPath = (p: string): boolean => {
    const norm = '/' + path.normalize(p).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase() + '/';
    return SENSITIVE_PATHS.some((sp) => norm.includes(`/${sp}/`));
  };
  return names(path.resolve(target)) || names(realCanonical(target))
    || matchesPath(path.resolve(target)) || matchesPath(realCanonical(target));
}

/** True when `target` is inside one of `roots` and names no credential store. */
export function isBrowsable(target: string, roots: string[]): boolean {
  if (touchesSensitiveDir(target)) return false;
  return roots.some((root) => isSubpath(root, target));
}
