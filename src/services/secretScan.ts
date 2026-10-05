import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { findSecrets, PROVIDER_SECRET_PATTERNS } from './secretRules.js';

/** Provider-shaped patterns (global regexes). Kept as an export for callers
 *  that redact retained output; detection goes through `findSecrets`. */
export const SECRET_PATTERNS = PROVIDER_SECRET_PATTERNS;

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
        if (content.includes('\0')) continue; // binary
        const lineStarts = buildLineStarts(content);
        for (const hit of findSecrets(content)) {
          // Locate the match by its own offset (a text search blamed every
          // repeat of a secret on its first occurrence).
          const lineNum = lineAtOffset(lineStarts, hit.index);
          findings.push({
            id: uuidv4(),
            type: 'Secret',
            severity: 'CRITICAL',
            title: `Detected ${hit.name}`,
            file: path.relative(repoPath, full),
            line: lineNum || 0,
            description: `A potential ${hit.name} was found in source code.`,
            status: 'open',
          });
        }
      }
    }
  };

  walk(repoPath, 0);
  return findings;
}
