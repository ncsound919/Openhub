/**
 * Language-aware analyzer registry (P1).
 *
 * Maps a file extension to a language and the analyzers that can operate on it.
 * This is the single source of truth the file collectors, typecheck/lint
 * scorers and the Deep payload all read — so a `.py` file is never silently
 * skipped because only the TS/JS extensions were hard-coded.
 */
import fs from 'fs';
import path from 'path';

export interface LanguageSpec {
  language: string;
  /** Short label used in coverage summaries, e.g. `py`, `ts`. */
  short: string;
  extensions: string[];
  analyzers: string[];
  /** UI/browser surfaces: forward DOM libs so `document`/`window` are not FPs. */
  browser?: boolean;
  /** Compiler options to forward to language analyzers (tsc-style). */
  compilerOptions?: Record<string, unknown>;
}

export const LANGUAGES: LanguageSpec[] = [
  {
    language: 'typescript',
    short: 'ts',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    analyzers: ['deep', 'tsc', 'eslint'],
    browser: true,
    compilerOptions: { lib: ['DOM', 'DOM.Iterable', 'ES2022'], strict: true, noEmit: true },
  },
  {
    language: 'javascript',
    short: 'js',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    analyzers: ['deep', 'eslint'],
    browser: true,
    compilerOptions: { lib: ['DOM', 'DOM.Iterable', 'ES2022'], allowJs: true, noEmit: true },
  },
  {
    language: 'python',
    short: 'py',
    extensions: ['.py'],
    analyzers: ['deep', 'ruff', 'flake8', 'mypy', 'bandit'],
  },
  {
    language: 'go',
    short: 'go',
    extensions: ['.go'],
    analyzers: ['deep', 'go-vet'],
  },
  {
    language: 'rust',
    short: 'rs',
    extensions: ['.rs'],
    analyzers: ['deep', 'clippy'],
  },
  {
    language: 'java',
    short: 'java',
    extensions: ['.java'],
    analyzers: ['deep'],
  },
  {
    language: 'kotlin',
    short: 'kt',
    extensions: ['.kt', '.kts'],
    analyzers: ['deep'],
  },
  {
    language: 'csharp',
    short: 'cs',
    extensions: ['.cs'],
    analyzers: ['deep'],
  },
  {
    language: 'ruby',
    short: 'rb',
    extensions: ['.rb'],
    analyzers: ['deep'],
  },
  {
    language: 'php',
    short: 'php',
    extensions: ['.php'],
    analyzers: ['deep'],
  },
  {
    language: 'c_cpp',
    short: 'cpp',
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'],
    analyzers: ['deep'],
  },
  {
    language: 'swift',
    short: 'swift',
    extensions: ['.swift'],
    analyzers: ['deep'],
  },
];

const EXT_TO_SPEC = new Map<string, LanguageSpec>();
for (const spec of LANGUAGES) {
  for (const ext of spec.extensions) EXT_TO_SPEC.set(ext, spec);
}

export const SUPPORTED_EXTENSIONS: string[] = Array.from(EXT_TO_SPEC.keys());

/** Extension → language name. Unknown extensions return `'text'`. */
export function languageForExt(ext: string): string {
  return EXT_TO_SPEC.get(ext.toLowerCase())?.language ?? 'text';
}

/** Extension → analyzer ids that can run against it. */
export function analyzersForExt(ext: string): string[] {
  return EXT_TO_SPEC.get(ext.toLowerCase())?.analyzers ?? [];
}

export function languageSpecFor(ext: string): LanguageSpec | undefined {
  return EXT_TO_SPEC.get(ext.toLowerCase());
}

/** The language a path belongs to, based on its extension. */
export function languageForPath(file: string): string {
  return languageForExt(path.extname(file).toLowerCase());
}

// ---------------------------------------------------------------------------
// Generic, bounded source walker
// ---------------------------------------------------------------------------

export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'coverage', '.turbo', 'build', '.next',
  '.godot', 'vendor', '.vs', '__pycache__', '.venv', 'venv', 'env',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'target', 'out',
  '.idea', '.vscode', 'release', '.tox', '.eggs',
]);

export interface SourceFile {
  file: string;
  content: string;
  language: string;
}

export interface CollectSourceOptions {
  /** Restrict to these extensions (lower-case, with dot). Default: all known. */
  extensions?: Iterable<string>;
  maxFiles?: number;
  /** Files larger than this are skipped (default 2 MB). */
  maxFileBytes?: number;
  skipDirs?: Set<string>;
  maxDepth?: number;
  /** Skip directories whose name starts with a dot. Default true. */
  skipDotDirs?: boolean;
}

const DEFAULTS = {
  maxFiles: 400,
  maxFileBytes: 2 * 1024 * 1024,
  maxDepth: 12,
};

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithinDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Read a regular file as UTF-8 through one descriptor, refusing anything over
 * `maxBytes` (checked with fstat on the opened file, so a swap between the size
 * check and the read cannot slip a larger file in). Returns null to skip.
 */
export function readFileCapped(file: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Walk `targetDir` collecting source files, bounded by count/depth/size. The
 * walk is deterministic (readdir order), skips vendored/build/dot directories,
 * and never throws on an unreadable entry.
 */
export function collectSourceFiles(
  targetDir: string,
  options: CollectSourceOptions = {},
): SourceFile[] {
  const out: SourceFile[] = [];
  const extensions = options.extensions ? new Set(options.extensions) : null;
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
  const maxFileBytes = options.maxFileBytes ?? DEFAULTS.maxFileBytes;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipDotDirs = options.skipDotDirs ?? true;
  // Symlinks are followed only when their target stays inside the scan root;
  // a repo must not be able to pull e.g. ~/.ssh or the server's key files into
  // the scan (and from there into an LLM prompt).
  const rootReal = realOrResolved(targetDir);

  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (skipDotDirs && entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions && !extensions.has(ext)) continue;
      if (!extensions && !EXT_TO_SPEC.has(ext)) continue;
      try {
        if (entry.isSymbolicLink()) {
          let real: string;
          try {
            real = fs.realpathSync.native(full);
          } catch {
            continue; // dangling link
          }
          if (!isWithinDir(real, rootReal)) continue;
        }
        const content = readFileCapped(full, maxFileBytes);
        if (content === null) continue;
        out.push({
          file: path.relative(targetDir, full).replace(/\\/g, '/'),
          content,
          language: languageForExt(ext),
        });
      } catch {
        /* unreadable — skip honestly */
      }
    }
  };

  walk(targetDir, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Coverage summary
// ---------------------------------------------------------------------------

export interface LanguageBreakdown {
  /** Total files scanned. */
  files: number;
  /** per-language count keyed by language name. */
  counts: Record<string, number>;
  /** Extensions present in the tree that no analyzer supports. */
  unsupported: number;
  /** Human summary, e.g. `99 files (73 py, 26 ts) · 0 unsupported`. */
  summary: string;
}

/** Build the language breakdown shown in the deep/analyzer coverage line. */
export function formatLanguageBreakdown(files: readonly SourceFile[]): LanguageBreakdown {
  const counts: Record<string, number> = {};
  let unsupported = 0;
  for (const f of files) {
    if (f.language === 'text') {
      unsupported += 1;
      continue;
    }
    counts[f.language] = (counts[f.language] ?? 0) + 1;
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([language, n]) => `${n} ${shortForLanguage(language)}`);
  return {
    files: files.length,
    counts,
    unsupported,
    summary: `${files.length} file${files.length === 1 ? '' : 's'}${
      parts.length ? ` (${parts.join(', ')})` : ''
    } · ${unsupported} unsupported`,
  };
}

export function shortForLanguage(language: string): string {
  for (const spec of LANGUAGES) if (spec.language === language) return spec.short;
  return language;
}
