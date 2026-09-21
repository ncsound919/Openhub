import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const SECRET_PATTERNS = [
  { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic Token', regex: /token:[a-zA-Z0-9-._~+/]{20,}/g },
  { name: 'Private Key', regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Firebase Config', regex: /apiKey:\s*"[a-zA-Z0-9-_]{39}"/g },
  { name: 'GitHub Token', regex: /ghp_[a-zA-Z0-9]{36}/g },
];

export interface SecretFinding {
  id: string;
  type: 'Secret';
  severity: 'CRITICAL';
  title: string;
  file: string;
  line: number;
  description: string;
  status: 'open';
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/** Loop guard for pathological trees — not a scanning limit. */
const MAX_DEPTH = 64;

/** Offsets at which each line begins, for offset -> line lookups. */
export function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Map a character offset in the file to a 1-based line number. */
export function lineAtOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Deterministically scan a repository tree for hardcoded secrets. Skips vendor
 * directories and files larger than 1 MB. Returns findings with file/line info.
 */
export function scanRepoForSecrets(repoPath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  // A depth cap silently truncates the scan and reports the rest of the tree as
  // clean — the worst failure mode for a security scanner. Anything below the
  // old depth of 8 was simply never looked at.
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: any[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }) as any[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        let content: string;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 1024 * 1024) continue;
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        const lineStarts = buildLineStarts(content);
        for (const p of SECRET_PATTERNS) {
          p.regex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = p.regex.exec(content)) !== null) {
            // Locate the match by its own offset. Searching the file for the
            // matched TEXT returned the FIRST line containing it, so every
            // repeat of a secret was blamed on the first occurrence — and the
            // per-match linear scan made large files quadratic.
            const lineNum = lineAtOffset(lineStarts, match.index);
            // A zero-width match would otherwise spin here forever.
            if (match[0].length === 0) p.regex.lastIndex += 1;
            findings.push({
              id: uuidv4(),
              type: 'Secret',
              severity: 'CRITICAL',
              title: `Detected ${p.name}`,
              file: path.relative(repoPath, full),
              line: lineNum || 0,
              description: `A potential ${p.name} was found in source code.`,
              status: 'open',
            });
          }
        }
      }
    }
  };

  walk(repoPath, 0);
  return findings;
}
