import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runLlm, type LlmMessage } from '../services/llmRouter.js';
import { reviewCodeDiff } from '../services/codeReviewer.js';
import type { ReviewComment, ReviewCategory, ReviewSeverity, ReviewDeterminism } from '../services/codeReviewer.js';
import { getGitHubIntegration } from '../services/githubService.js';
import { getDb } from '../auth/db.js';
import { resolveReviewTarget, isSafeGitRef } from '../lib/reviewTarget.js';

const execFileAsync = promisify(execFile);

/** The authenticated subject, as the auth middleware puts it on the request. */
function callerId(req: express.Request): string | undefined {
  const sub = (req.user as { sub?: unknown } | undefined)?.sub;
  return typeof sub === 'string' && sub.trim() ? sub : undefined;
}

/**
 * Auth-gated AI pull-request review routes.
 * Mount at `/api` (server.ts), yielding:
 *   POST /api/ai/review       — local diff + LLM review (workspace panel)
 *   POST /api/ai/review/pr    — GitHub PR diff + LLM + optional comment post-back
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AiReviewLocalBody {
  repoName?: string;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  repo?: string;
  model?: string;
  targetDir?: string;
  baseRef?: string;
}

interface AiReviewPrBody {
  owner: string;
  repo: string;
  pullNumber: number;
  model?: string;
  /** If true and GitHub integration is active, post review comments back via API. */
  postToGitHub?: boolean;
}

/** Shape the LLM is asked to return — an array of findings. */
interface LlmFinding {
  file: string;
  line: number;
  category: ReviewCategory;
  severity: ReviewSeverity;
  title: string;
  description: string;
  suggestedFix?: string;
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 120_000;

async function getLocalDiff(targetDir: string, baseRef = 'HEAD'): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', baseRef], {
      cwd: targetDir,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: MAX_DIFF_BYTES * 2,
    });
    if (stdout.trim()) return stdout.slice(0, MAX_DIFF_BYTES);
    // Try staged changes
    const { stdout: staged } = await execFileAsync('git', ['diff', '--cached'], {
      cwd: targetDir,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: MAX_DIFF_BYTES * 2,
    });
    return staged.slice(0, MAX_DIFF_BYTES);
  } catch {
    return '';
  }
}

async function getGitHubPrDiff(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.diff',
      'User-Agent': 'OpenHub-Autonomous-Platform/2.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub PR diff fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  return text.slice(0, MAX_DIFF_BYTES);
}

// ---------------------------------------------------------------------------
// LLM prompt helpers
// ---------------------------------------------------------------------------

const FINDING_SCHEMA = `[
  {
    "file": "relative/path/to/file.ts",
    "line": 42,
    "category": "security|complexity|performance|type_safety|api_contract|test_coverage|dependency_risk|documentation",
    "severity": "critical|warning|info",
    "title": "Short descriptive title",
    "description": "Detailed explanation of the issue and why it matters.",
    "suggestedFix": "Optional: brief description or code snippet of the fix"
  }
]`;

function buildSystemPrompt(): string {
  return `You are an expert code reviewer — precise, constructive, and security-aware. Your job is to analyze git diffs and return a JSON array of findings.

RULES:
1. Output ONLY valid JSON — an array of finding objects matching this schema:
${FINDING_SCHEMA}
2. Focus on real issues: security vulnerabilities, logic errors, performance problems, broken contracts, missing tests.
3. Be specific. Reference the actual code pattern you found, not generic advice.
4. Skip style-only issues (whitespace, naming conventions) unless they cause bugs.
5. If a file looks clean, do not include it — an empty array [] is a valid and good output.
6. Limit to the 10 most important findings to avoid noise.`;
}

function buildDiffPrompt(diff: string, context: { title?: string; prContext?: string }): string {
  const contextStr = context.prContext || context.title
    ? `Context: ${context.prContext || `PR titled "${context.title}"`}\n\n`
    : '';
  return `${contextStr}Analyze this git diff and return findings as JSON:\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function buildWalkthroughPrompt(diff: string, title?: string): string {
  const titleStr = title ? `PR: "${title}"\n\n` : '';
  return `${titleStr}Write a concise 2–4 sentence walk-through of what this changeset does, its intent, any notable risks, and what looks good. Plain prose, no markdown headers or bullet points:\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
}

/** Collect "file:newLine" for every ADDED line in a unified diff, so inline
 *  review comments only target lines GitHub will accept. */
function collectAddedLines(diff: string): Set<string> {
  const added = new Set<string>();
  const fileDiffs = diff.split(/^diff --git /m);
  for (const fDiff of fileDiffs) {
    if (!fDiff.trim()) continue;
    const fileMatch = fDiff.match(/^[ab]\/(.+?) [ab]\/(.+)/m) || fDiff.match(/^\+\+\+ b\/(.+)/m);
    const fileName = fileMatch ? (fileMatch[2] || fileMatch[1]).trim() : null;
    if (!fileName || fileName === '/dev/null') continue;
    const hunkBlocks = fDiff.split(/^@@ /m).slice(1);
    for (const block of hunkBlocks) {
      const headerMatch = block.match(/-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!headerMatch) continue;
      let newLine = parseInt(headerMatch[2], 10);
      const lines = block.split('\n').slice(1);
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          added.add(`${fileName}:${newLine}`);
          newLine += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // removed line: new-side counter does not advance
        } else {
          newLine += 1;
        }
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// LLM findings parser
// ---------------------------------------------------------------------------

function parseLlmFindings(text: string): LlmFinding[] {
  // Extract JSON array from response (may be wrapped in markdown fences)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
    text.match(/(\[[\s\S]*\])/);
  const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is LlmFinding =>
        typeof f === 'object' &&
        f !== null &&
        typeof f.file === 'string' &&
        typeof f.title === 'string' &&
        typeof f.description === 'string',
    );
  } catch {
    return [];
  }
}

function llmFindingsToComments(findings: LlmFinding[]): ReviewComment[] {
  return findings.map((f, idx) => ({
    id: `llm_finding_${idx + 1}`,
    file: f.file,
    line: typeof f.line === 'number' && f.line > 0 ? f.line : 1,
    ruleId: `ai/${f.category}`,
    category: f.category,
    severity: f.severity,
    determinism: 'ai-inferred' as ReviewDeterminism,
    title: f.title,
    description: f.description,
    ...(f.suggestedFix
      ? {
          suggestedPatch: {
            original: '// (see description)',
            replacement: f.suggestedFix,
          },
        }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// GitHub review post-back
// ---------------------------------------------------------------------------

async function postGitHubReview(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
  comments: ReviewComment[],
  walkthrough: string,
  diff?: string,
): Promise<void> {
  // Map findings to real diff lines. The reviews API rejects inline comments
  // whose line is not part of the PR diff, so only post inline comments for
  // (file, line) pairs that appear as ADDED lines in the fetched diff; the
  // rest are folded into the summary body instead of posted at a wrong spot.
  const addedLines = diff ? collectAddedLines(diff) : null;
  const mappable = comments.filter((c) => c.line > 0);
  const inlineComments = mappable
    .filter((c) => !addedLines || addedLines.has(`${c.file}:${c.line}`))
    .slice(0, 20) // GitHub caps review comments per request
    .map((c) => ({
      path: c.file,
      line: c.line,
      side: 'RIGHT' as const,
      body: `**[${c.severity.toUpperCase()}] ${c.title}**\n\n${c.description}${c.suggestedPatch ? `\n\n\`\`\`\nSuggested fix: ${c.suggestedPatch.replacement}\n\`\`\`` : ''}`,
    }));
  const unmapped = mappable.filter(
    (c) => addedLines && !addedLines.has(`${c.file}:${c.line}`),
  );
  const unmappedSection = unmapped.length
    ? `\n\n<details><summary>${unmapped.length} additional finding(s) outside the diff hunks</summary>\n\n${unmapped.map((c) => `- **${c.file}:${c.line}** [${c.severity}] ${c.title} — ${c.description}`).join('\n')}\n\n</details>`
    : '';

  const body = {
    body: `## OpenHub AI Code Review\n\n${walkthrough || 'Automated review by OpenHub.'}\n\n_${comments.length} finding(s) detected._${unmappedSection}`,
    event: comments.some((c) => c.severity === 'critical') ? 'REQUEST_CHANGES' : 'COMMENT',
    comments: inlineComments,
  };

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'OpenHub-Autonomous-Platform/2.0',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub review post failed: HTTP ${res.status} — ${detail.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAiReviewRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  /**
   * POST /api/ai/review
   * Full AI + static review of a local working-tree diff.
   * Replaces the old metadata-only endpoint.
   */
  router.post('/ai/review', async (req, res) => {
    try {
      const {
        repoName,
        title,
        sourceBranch,
        targetBranch,
        model,
        targetDir,
        baseRef,
      } = (req.body ?? {}) as AiReviewLocalBody;

      if (!repoName || typeof repoName !== 'string') {
        return res.status(400).json({ ok: false, error: 'Missing required field: repoName' });
      }

      // `targetDir` spawns `git diff` server-side, so it must be resolved
      // against the caller's active project / the configured repo roots — never
      // taken at face value (a raw path here discloses any repo on the host).
      const target = resolveReviewTarget(callerId(req), targetDir);
      if (!target.ok) {
        return res.status(target.status).json({ ok: false, error: target.error });
      }
      if (baseRef !== undefined && !isSafeGitRef(baseRef)) {
        return res.status(400).json({ ok: false, error: 'Invalid baseRef' });
      }
      const dir = target.dir;

      // 1. Run static rules immediately
      const staticResult = await reviewCodeDiff(dir, {
        baseRef: baseRef || 'HEAD',
      });

      // 2. Fetch real diff for LLM
      const diff = await getLocalDiff(dir, baseRef || 'HEAD');

      let llmComments: ReviewComment[] = [];
      let walkthrough: string | undefined;

      if (diff.trim()) {
        const prCtx = title
          ? `PR "${title}" — ${sourceBranch ?? 'feature'} → ${targetBranch ?? 'main'} in ${repoName}`
          : `Repository: ${repoName}`;

        // 3. LLM findings (structured JSON)
        const [findingsResult, walkthroughResult] = await Promise.allSettled([
          runLlm(
            [
              { role: 'system', content: buildSystemPrompt() },
              { role: 'user', content: buildDiffPrompt(diff, { prContext: prCtx }) },
            ],
            typeof model === 'string' && model.trim() ? { model: model.trim(), timeoutMs: 90_000 } : { timeoutMs: 90_000 },
          ),
          runLlm(
            [
              {
                role: 'system',
                content:
                  'You are a senior engineer. Write a concise, plain-prose walk-through of what the provided code change does. Do not use markdown headers or bullet lists.',
              },
              { role: 'user', content: buildWalkthroughPrompt(diff, title) },
            ],
            typeof model === 'string' && model.trim() ? { model: model.trim(), timeoutMs: 30_000 } : { timeoutMs: 30_000 },
          ),
        ]);

        if (findingsResult.status === 'fulfilled' && findingsResult.value.ok && findingsResult.value.text) {
          const parsed = parseLlmFindings(findingsResult.value.text);
          llmComments = llmFindingsToComments(parsed);
        }

        if (walkthroughResult.status === 'fulfilled' && walkthroughResult.value.ok && walkthroughResult.value.text) {
          walkthrough = walkthroughResult.value.text;
        }
      }

      // 4. Merge static + LLM findings (LLM findings that duplicate static findings are appended, not deduped, to show both signals)
      const mergedComments = [...staticResult.comments, ...llmComments];

      // 5. Re-compute summary with merged comments
      const critical = mergedComments.filter((c) => c.severity === 'critical').length;
      const warning = mergedComments.filter((c) => c.severity === 'warning').length;
      const info = mergedComments.filter((c) => c.severity === 'info').length;
      const verdict =
        critical > 0 ? 'REQUEST_CHANGES' : warning > 0 ? 'COMMENT' : 'APPROVE';

      return res.json({
        ok: true,
        text: walkthrough ?? null, // kept for backwards compat with PullsView
        result: {
          ...staticResult,
          walkthrough,
          comments: mergedComments,
          summary: { ...staticResult.summary, critical, warning, info },
          verdict,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: message || 'Failed to generate AI review' });
    }
  });

  /**
   * POST /api/ai/review/pr
   * GitHub PR diff + LLM review, with optional inline comment post-back.
   */
  router.post('/ai/review/pr', async (req, res) => {
    try {
      const { owner, repo, pullNumber, model, postToGitHub = false } = (req.body ?? {}) as AiReviewPrBody;

      if (!owner || !repo || !pullNumber) {
        return res.status(400).json({ ok: false, error: 'owner, repo, and pullNumber are required' });
      }

      // Resolve GitHub token from the authenticated user's stored integration
      const userId = (req as any).user?.id as string | undefined;
      const integration = userId ? getGitHubIntegration(userId) : null;
      const token = integration?.accessToken;

      if (!token) {
        return res.status(401).json({
          ok: false,
          error: 'GitHub integration not connected. Link your GitHub account in Settings.',
        });
      }

      const diff = await getGitHubPrDiff(owner, repo, pullNumber, token);
      if (!diff.trim()) {
        return res.json({ ok: true, result: null, message: 'No diff found for this PR.' });
      }

      const prCtx = `GitHub PR #${pullNumber} in ${owner}/${repo}`;

      const [findingsResult, walkthroughResult] = await Promise.allSettled([
        runLlm(
          [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: buildDiffPrompt(diff, { prContext: prCtx }) },
          ],
          typeof model === 'string' && model.trim() ? { model: model.trim(), timeoutMs: 90_000 } : { timeoutMs: 90_000 },
        ),
        runLlm(
          [
            {
              role: 'system',
              content:
                'You are a senior engineer. Write a concise, plain-prose walk-through of what the provided code change does. Do not use markdown headers or bullet lists.',
            },
            { role: 'user', content: buildWalkthroughPrompt(diff, `PR #${pullNumber}`) },
          ],
          typeof model === 'string' && model.trim() ? { model: model.trim(), timeoutMs: 30_000 } : { timeoutMs: 30_000 },
        ),
      ]);

      const llmText =
        findingsResult.status === 'fulfilled' && findingsResult.value.ok
          ? findingsResult.value.text ?? ''
          : '';
      const walkthrough =
        walkthroughResult.status === 'fulfilled' && walkthroughResult.value.ok
          ? (walkthroughResult.value.text ?? undefined)
          : undefined;

      const llmComments = llmFindingsToComments(parseLlmFindings(llmText));

      const critical = llmComments.filter((c) => c.severity === 'critical').length;
      const warning = llmComments.filter((c) => c.severity === 'warning').length;
      const info = llmComments.filter((c) => c.severity === 'info').length;
      const verdict =
        critical > 0 ? 'REQUEST_CHANGES' : warning > 0 ? 'COMMENT' : 'APPROVE';

      // Post to GitHub if requested
      let postedToGitHub = false;
      let postError: string | undefined;
      if (postToGitHub && token) {
        try {
          await postGitHubReview(owner, repo, pullNumber, token, llmComments, walkthrough ?? '', diff);
          postedToGitHub = true;
        } catch (err) {
          postError = err instanceof Error ? err.message : String(err);
        }
      }

      const fileScores: Record<string, number> = {};
      const fileGroups = llmComments.reduce<Record<string, ReviewComment[]>>((acc, c) => {
        (acc[c.file] = acc[c.file] || []).push(c);
        return acc;
      }, {});
      for (const [file, comments] of Object.entries(fileGroups)) {
        const penalty = comments.reduce(
          (acc, c) => acc + (c.severity === 'critical' ? 30 : c.severity === 'warning' ? 10 : 3),
          0,
        );
        fileScores[file] = Math.max(0, 100 - penalty);
      }

      return res.json({
        ok: true,
        result: {
          targetDir: `${owner}/${repo}`,
          branchOrRef: `pr/${pullNumber}`,
          reviewedAt: new Date().toISOString(),
          reviewSessionId: `ghpr_${pullNumber}_${Date.now().toString(36)}`,
          verdict,
          walkthrough,
          summary: {
            critical,
            warning,
            info,
            filesReviewed: Object.keys(fileGroups).length,
            linesChanged: 0,
          },
          comments: llmComments,
          fileScores,
        },
        postedToGitHub,
        ...(postError ? { postError } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: message || 'Failed to generate PR review' });
    }
  });

  /**
   * POST /api/ai/review/pr/publish
   * Publish a pre-built PR review (e.g. from The Deep) through OpenHub's
   * GitHub token. Body: { owner, repo, pullNumber, comments[], body?, event? }.
   */
  router.post('/ai/review/pr/publish', async (req, res) => {
    try {
      const { owner, repo, pullNumber, comments, body } = (req.body ?? {}) as {
        owner?: string;
        repo?: string;
        pullNumber?: number;
        comments?: Array<Partial<ReviewComment>>;
        body?: string;
        event?: string;
      };

      if (!owner || !repo || !pullNumber) {
        return res.status(400).json({ ok: false, error: 'owner, repo, and pullNumber are required' });
      }
      if (!Array.isArray(comments)) {
        return res.status(400).json({ ok: false, error: 'comments must be an array' });
      }

      const userId = (req as any).user?.id as string | undefined;
      const integration = userId ? getGitHubIntegration(userId) : null;
      const token = integration?.accessToken;
      if (!token) {
        return res.status(401).json({
          ok: false,
          error: 'GitHub integration not connected. Link your GitHub account in Settings.',
        });
      }

      const mapped: ReviewComment[] = comments.map((c, i) => ({
        id: String(c.id ?? `deep_${i}`),
        file: String(c.file ?? ''),
        line: Number(c.line ?? 0),
        ruleId: String(c.ruleId ?? 'the-deep'),
        category: (c.category ?? 'security') as ReviewCategory,
        severity: (c.severity ?? 'info') as ReviewSeverity,
        determinism: (c.determinism ?? 'deterministic') as ReviewDeterminism,
        title: String(c.title ?? 'Finding'),
        description: String(c.description ?? ''),
        ...(c.suggestedPatch ? { suggestedPatch: c.suggestedPatch } : {}),
      }));

      let diff: string | undefined;
      try {
        diff = await getGitHubPrDiff(owner, repo, pullNumber, token);
      } catch {
        diff = undefined; // summary-only review; inline mapping is best-effort
      }

      await postGitHubReview(owner, repo, pullNumber, token, mapped, String(body ?? ''), diff);
      return res.json({ ok: true, posted: mapped.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: message || 'Failed to publish PR review' });
    }
  });

  return router;
}