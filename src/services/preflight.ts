/**
 * Audit tool preflight (P4 / workstream G1).
 *
 * Before an audit runs more tools, probe which ones are actually alive on this
 * machine/target and report the rest as explicit gaps. Skipping a missing tool
 * fast (instead of waiting for its timeout) is what keeps the wall-clock budget
 * bounded, and it keeps the audit honest: absence is reported, never scored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { probeTool, type ToolProbe } from './processRunner.js';
import type { Dimension } from './dimensions.js';

export interface ToolCapability extends ToolProbe {
  kind: 'local' | 'service';
  /** Dimension the tool would feed when available. */
  dimension?: Dimension;
}

export interface PreflightReport {
  target: string | null;
  tools: ToolCapability[];
  ready: string[];
  missing: string[];
  checkedAt: string;
}

export interface TargetSignals {
  hasPackageJson: boolean;
  hasTsconfig: boolean;
  hasEslintConfig: boolean;
  hasJscpdConfig: boolean;
  hasPython: boolean;
  hasIaC: boolean;
  hasHtml: boolean;
  hasOpenApi: boolean;
  hasLicenseTool: boolean;
  isGitRepo: boolean;
}

const ESLINT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
];
const OPENAPI_NAMES = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json'];
const IAC_NAMES = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'main.tf', 'variables.tf', 'terraform.tf'];

/** Detect what kinds of analysis the target justifies, without spawning anything. */
export function detectTargetSignals(targetDir?: string): TargetSignals {
  const has = (rel: string): boolean => {
    if (!targetDir) return false;
    try { return fs.existsSync(path.join(targetDir, rel)); } catch { return false; }
  };
  const scan = (predicate: (name: string) => boolean, maxDepth = 2): boolean => {
    if (!targetDir) return false;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv', 'venv', 'target', 'vendor']);
    const walk = (dir: string, depth: number): boolean => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const e of entries) {
        if (predicate(e.name)) return true;
        if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && !skip.has(e.name)) {
          if (walk(path.join(dir, e.name), depth + 1)) return true;
        }
      }
      return false;
    };
    return walk(targetDir, 0);
  };
  return {
    hasPackageJson: has('package.json') || scan((n) => n === 'package.json'),
    hasTsconfig: has('tsconfig.json') || scan((n) => n === 'tsconfig.json' || n === 'jsconfig.json'),
    hasEslintConfig: ESLINT_CONFIGS.some(has) || scan((n) => n.startsWith('eslint.config') || n.startsWith('.eslintrc')),
    hasJscpdConfig: has('.jscpd.json') || scan((n) => n === '.jscpd.json' || n === 'jscpd.json'),
    hasPython: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pytest.ini'].some(has)
      || scan((n) => n.endsWith('.py')),
    hasIaC: IAC_NAMES.some(has) || scan((n) => n.endsWith('.tf')),
    hasHtml: scan((n) => n.endsWith('.html') || n.endsWith('.htm')),
    hasOpenApi: OPENAPI_NAMES.some(has) || scan((n) => /openapi|swagger/i.test(n)),
    hasLicenseTool: has('package.json'),
    isGitRepo: has('.git'),
  };
}

interface ToolSpec {
  name: string;
  versionArgs: string[];
  kind: 'local' | 'service';
  dimension?: Dimension;
}

/** Which tools to probe for a given target, derived from its signals. */
export function planToolProbes(signals: TargetSignals): ToolSpec[] {
  const specs: ToolSpec[] = [];
  const add = (name: string, versionArgs: string[], dimension?: Dimension) =>
    specs.push({ name, versionArgs, kind: 'local', dimension });

  if (signals.isGitRepo) add('git', ['--version'], 'security');
  if (signals.hasTsconfig) add('tsc', ['--version'], 'build_ci');
  if (signals.hasEslintConfig) add('eslint', ['--version'], 'maintainability');
  if (signals.hasPackageJson || signals.hasTsconfig) {
    add('jscpd', ['--version'], 'maintainability');
    add('license-checker', ['--version'], 'licenses');
  }
  if (signals.hasPython) {
    add('pytest', ['--version'], 'tests');
    add('ruff', ['--version'], 'maintainability');
    add('flake8', ['--version'], 'maintainability');
    add('mypy', ['--version'], 'build_ci');
  }
  if (signals.hasIaC) {
    add('tfsec', ['--version'], 'security');
    add('checkov', ['--version'], 'security');
    add('trivy', ['--version'], 'security');
    add('syft', ['--version'], 'licenses');
  }
  if (signals.hasHtml) add('pa11y', ['--version'], 'accessibility');
  if (signals.hasOpenApi) add('openapi-diff', ['--version'], 'architecture');
  add('gitleaks', ['version'], 'security');
  return specs;
}

export interface PreflightOptions {
  /** Skip spawning probes entirely and report everything as unknown/missing. */
  probe?: boolean;
  timeoutMs?: number;
}

/**
 * Build the capability grid for a target. Probes run in parallel so the check
 * costs roughly one tool's startup, not the sum of all of them.
 */
export async function preflightAuditTools(
  targetDir?: string,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const { probe = true, timeoutMs = 8_000 } = options;
  const signals = detectTargetSignals(targetDir);
  const specs = planToolProbes(signals);
  const tools: ToolCapability[] = [];

  if (!targetDir || !probe) {
    for (const spec of specs) {
      tools.push({
        name: spec.name,
        kind: spec.kind,
        available: false,
        ...(spec.dimension ? { dimension: spec.dimension } : {}),
        reason: targetDir ? 'probe disabled' : 'no local target dir',
      });
    }
  } else {
    const probes = await Promise.all(
      specs.map(async (spec) => {
        const result = await probeTool(spec.name, spec.versionArgs, targetDir, timeoutMs);
        return { ...result, kind: spec.kind, ...(spec.dimension ? { dimension: spec.dimension } : {}) } as ToolCapability;
      }),
    );
    tools.push(...probes);
  }

  return {
    target: targetDir ?? null,
    tools,
    ready: tools.filter((t) => t.available).map((t) => t.name),
    missing: tools.filter((t) => !t.available).map((t) => t.name),
    checkedAt: new Date().toISOString(),
  };
}

/** Fast lookup: was the tool reported ready? Unknown tools return false. */
export function toolReady(report: PreflightReport | undefined, name: string): boolean {
  if (!report) return false;
  return report.tools.some((t) => t.name === name && t.available);
}

/** The reason a tool is unavailable, for honest skip messages. */
export function toolReason(report: PreflightReport | undefined, name: string): string {
  const tool = report?.tools.find((t) => t.name === name);
  if (!tool) return `${name} not probed for this target`;
  return tool.reason ?? tool.version ?? `${name} unavailable`;
}
