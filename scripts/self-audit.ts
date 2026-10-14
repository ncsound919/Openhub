/**
 * Run OpenHub's own audit suite against a directory (default: this repo) and
 * print a readable summary. This is "use the system on itself":
 *
 *   npm run audit:self            # quick preset
 *   npm run audit:self -- standard
 *   npm run audit:self -- quick ../some-other-project
 *
 * Exit code is 0 unless the audit fails to RUN (a `fail` verdict from real
 * findings is a result, not a script error).
 */
import path from 'node:path';
import { executeAuditSuite, type AuditPresetName } from '../src/services/auditSuite.js';

const args = process.argv.slice(2);
const preset = (['quick', 'standard', 'deep', 'release'] as string[]).includes(args[0]) ? (args[0] as AuditPresetName) : 'quick';
const targetDir = path.resolve(args.find((a) => a.startsWith('.')) ?? process.cwd());

const t0 = Date.now();
const report = await executeAuditSuite({ targetDir, preset });

console.log(`=== SELF-AUDIT (${preset}) ===`);
console.log(`target:  ${targetDir}`);
console.log(`overall: ${report.overallStatus}  score=${report.overallScore}  grade=${report.grade}  critical=${report.criticalFindings}`);
console.log(`verdict: ${report.verdictReason ?? 'n/a'} — ${report.verdictDetail ?? ''}`);
console.log(`coverage: ${report.coveragePercent}%  findings=${report.findings.length}`);
console.log('--- scorers ---');
for (const r of report.results) {
  const score = typeof r.score === 'number' ? String(r.score) : 'n/a';
  console.log(`${r.scorer.padEnd(16)} ${score.padStart(4)}  ${r.error ? 'ERROR: ' + r.error : r.summary}`);
}
console.log('--- top findings ---');
for (const f of report.findings.slice(0, 20)) {
  const loc = f.location?.file ? `${f.location.file}${f.location.line ? ':' + f.location.line : ''}` : '(no location)';
  console.log(`[${f.severity}] ${f.dimension}/${f.category} ${loc} — ${f.evidence ?? f.remediation ?? ''}`);
}
console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)}s`);
