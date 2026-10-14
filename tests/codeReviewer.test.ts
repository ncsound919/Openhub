import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  parseUnifiedDiff,
  reviewDiff,
  applyReviewPatch,
  type ReviewComment,
} from '../src/services/codeReviewer.js';
import { createCodeReviewRouter } from '../src/routes/codeReviewRoutes.js';
import { clearReceipts, listReceipts } from '../src/services/receipts.js';

/**
 * These tests are written against the reviewer's ACTUAL rule ids and response
 * shape. The previous revision asserted ids that do not exist in the rule table
 * (`security/hardcoded-secret`, `security/eval-injection`,
 * `reliability/empty-catch`), a `res.body.data` envelope the router never
 * produced, and request fields (`rawDiff`, `filePath`) the router never read —
 * so the suite could not have passed against any version of this code.
 */

function findByRule(comments: ReviewComment[], ruleId: string) {
  return comments.find((c) => c.ruleId === ruleId);
}

describe('Autonomous Semantic Code Reviewer', () => {
  let tempDir: string;
  let previousExtraRoots: string | undefined;

  beforeEach(() => {
    clearReceipts();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-review-test-')));
    // The router only accepts a targetDir inside an allowlisted repo root.
    previousExtraRoots = process.env.OPENHUB_EXTRA_REPO_ROOTS;
    process.env.OPENHUB_EXTRA_REPO_ROOTS = tempDir;
  });

  afterEach(() => {
    if (previousExtraRoots === undefined) delete process.env.OPENHUB_EXTRA_REPO_ROOTS;
    else process.env.OPENHUB_EXTRA_REPO_ROOTS = previousExtraRoots;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('Unified Diff Parsing', () => {
    it('parses a multi-file unified git diff into hunks', () => {
      const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index abc..def 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,3 +10,4 @@
 function login() {
+  const token = '123';
   return token;
 }
`;
      const hunks = parseUnifiedDiff(sampleDiff);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].file).toBe('src/auth.ts');
      expect(hunks[0].oldLine).toBe(10);
      expect(hunks[0].newLine).toBe(10);
      expect(hunks[0].lines.some((l) => l.includes("const token = '123'"))).toBe(true);
    });
  });

  describe('Static rules', () => {
    it('flags a hardcoded secret as critical', async () => {
      const diff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,4 @@
+const stripeKey = "sk_live_12345678901234567890";
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(result.verdict).toBe('REQUEST_CHANGES');
      const secret = findByRule(result.comments, 'security/no-hardcoded-secrets');
      expect(secret).toBeDefined();
      expect(secret?.severity).toBe('critical');
      // The auto-patch was removed: it produced code that did not parse.
      expect(secret?.suggestedPatch).toBeUndefined();
      expect(listReceipts().some((r) => r.label?.includes('semantic_reviewer'))).toBe(true);
    });

    it('does not exempt a line merely because it contains the substring "test"', async () => {
      const diff = `diff --git a/src/latest.ts b/src/latest.ts
--- a/src/latest.ts
+++ b/src/latest.ts
@@ -1,3 +1,4 @@
+const latestApiKey = "sk_live_98765432109876543210";
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(findByRule(result.comments, 'security/no-hardcoded-secrets')).toBeDefined();
    });

    it('still exempts an obvious placeholder', async () => {
      const diff = `diff --git a/src/sample.ts b/src/sample.ts
--- a/src/sample.ts
+++ b/src/sample.ts
@@ -1,3 +1,4 @@
+const apiKey = "EXAMPLE_0000000000000000";
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(findByRule(result.comments, 'security/no-hardcoded-secrets')).toBeUndefined();
    });

    it('flags eval as critical', async () => {
      const diff = `diff --git a/src/calc.ts b/src/calc.ts
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -1,3 +1,4 @@
+const outcome = eval(expression);
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(result.verdict).toBe('REQUEST_CHANGES');
      const evalComment = findByRule(result.comments, 'security/no-eval');
      expect(evalComment?.severity).toBe('critical');
    });

    it('flags an empty catch as a warning', async () => {
      const diff = `diff --git a/src/handler.ts b/src/handler.ts
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,3 +1,4 @@
+catch (err) { }
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      const c = findByRule(result.comments, 'complexity/no-empty-catch');
      expect(c?.severity).toBe('warning');
    });

    it('does not report an innerHTML comparison as an XSS sink', async () => {
      const diff = `diff --git a/src/dom.ts b/src/dom.ts
--- a/src/dom.ts
+++ b/src/dom.ts
@@ -1,3 +1,4 @@
+if (el.innerHTML === expected) { return; }
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(findByRule(result.comments, 'security/xss-innerhtml')).toBeUndefined();
    });

    it('still reports an innerHTML assignment from a variable', async () => {
      const diff = `diff --git a/src/dom.ts b/src/dom.ts
--- a/src/dom.ts
+++ b/src/dom.ts
@@ -1,3 +1,4 @@
+el.innerHTML = userSuppliedMarkup;
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(findByRule(result.comments, 'security/xss-innerhtml')?.severity).toBe('critical');
    });

    it('reports the critical rule on a deeply indented line, not only the info one', async () => {
      // Regression: rules were evaluated in array order and the loop `break`-ed
      // on the first hit, so `complexity/excessive-nesting` (info) suppressed a
      // hardcoded secret (critical) on the same line.
      const diff = `diff --git a/src/deep.ts b/src/deep.ts
--- a/src/deep.ts
+++ b/src/deep.ts
@@ -1,3 +1,4 @@
+                const apiKey = "sk_live_11112222333344445555";
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(findByRule(result.comments, 'security/no-hardcoded-secrets')?.severity).toBe('critical');
      expect(result.verdict).toBe('REQUEST_CHANGES');
    });

    it('approves a clean diff', async () => {
      const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
+export function add(a: number, b: number): number {
+  return a + b;
+}
`;
      const result = await reviewDiff(tempDir, { diffText: diff });
      expect(result.summary.critical).toBe(0);
      expect(result.summary.warning).toBe(0);
    });

    it('rejects an option-shaped baseRef instead of handing it to git', async () => {
      await expect(reviewDiff(tempDir, { baseRef: '--output=/tmp/pwned' })).rejects.toThrow(/Invalid baseRef/);
    });
  });

  describe('applyReviewPatch containment', () => {
    it('applies a patch to a file inside the target directory', () => {
      const targetFile = path.join(tempDir, 'service.ts');
      fs.writeFileSync(targetFile, 'const secret = "sk_live_12345678901234567890";\nconsole.log(secret);\n');

      const res = applyReviewPatch(
        tempDir,
        'service.ts',
        'const secret = "sk_live_12345678901234567890";',
        'const secret = process.env.API_KEY || "";',
      );

      expect(res.success).toBe(true);
      const updated = fs.readFileSync(targetFile, 'utf8');
      expect(updated).toContain('process.env.API_KEY');
      expect(updated).not.toContain('sk_live_12345678901234567890');
    });

    it('reports drift when the original snippet is absent', () => {
      fs.writeFileSync(path.join(tempDir, 'drift.ts'), 'const modified = true;\n');
      const res = applyReviewPatch(tempDir, 'drift.ts', 'const missingSnippet = 42;', 'const replaced = 100;');
      expect(res.success).toBe(false);
      expect(res.error).toContain('drift detected');
    });

    it('refuses an empty original snippet', () => {
      // Regression: `content.includes('')` is always true, so an empty original
      // turned the drift check into a no-op and `replace('', x)` prepended `x`
      // to any file — an unconditional write primitive.
      const targetFile = path.join(tempDir, 'empty.ts');
      fs.writeFileSync(targetFile, 'const untouched = true;\n');
      const res = applyReviewPatch(tempDir, 'empty.ts', '', 'INJECTED\n');
      expect(res.success).toBe(false);
      expect(fs.readFileSync(targetFile, 'utf8')).toBe('const untouched = true;\n');
    });

    it('refuses a path that escapes the target directory', () => {
      // Regression: `path.resolve(targetDir, filePath)` with a traversing
      // filePath wrote anywhere on the host.
      const outside = path.join(tempDir, 'outside.txt');
      fs.writeFileSync(outside, 'original\n');
      const inner = path.join(tempDir, 'repo');
      fs.mkdirSync(inner);

      const res = applyReviewPatch(inner, '../outside.txt', 'original', 'PWNED');
      expect(res.success).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('original\n');
    });

    it('refuses an ambiguous snippet that occurs more than once', () => {
      const targetFile = path.join(tempDir, 'dup.ts');
      fs.writeFileSync(targetFile, 'let x = 1;\nlet x = 1;\n');
      const res = applyReviewPatch(tempDir, 'dup.ts', 'let x = 1;', 'let y = 2;');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/more than once/);
    });
  });

  describe('REST endpoints', () => {
    function makeApp() {
      const app = express();
      app.use(express.json());
      app.use('/api/review', createCodeReviewRouter());
      return app;
    }

    it('POST /api/review/diff returns a structured review under `result`', async () => {
      const res = await request(makeApp())
        .post('/api/review/diff')
        .send({
          targetDir: tempDir,
          diffText: 'diff --git a/test.ts b/test.ts\n+++ b/test.ts\n@@ -1,1 +1,2 @@\n+const x = eval("2+2");\n',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.result.verdict).toBe('REQUEST_CHANGES');
      expect(res.body.result.comments.length).toBeGreaterThanOrEqual(1);
    });

    it('POST /api/review/diff rejects a targetDir outside the allowed roots', async () => {
      const res = await request(makeApp())
        .post('/api/review/diff')
        .send({ targetDir: os.homedir(), diffText: 'diff --git a/a.ts b/a.ts\n' });
      expect(res.status).toBe(403);
    });

    it('POST /api/review/apply-suggestion patches a file in the target directory', async () => {
      fs.writeFileSync(path.join(tempDir, 'fix.ts'), 'const old = 1;\n');
      const res = await request(makeApp())
        .post('/api/review/apply-suggestion')
        .send({
          targetDir: tempDir,
          file: 'fix.ts',
          original: 'const old = 1;',
          replacement: 'const fixed = 2;',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(fs.readFileSync(path.join(tempDir, 'fix.ts'), 'utf8')).toContain('const fixed = 2;');
    });

    it('POST /api/review/apply-suggestion cannot write outside the allowed roots', async () => {
      const victim = path.join(os.tmpdir(), `openhub-victim-${process.pid}.txt`);
      fs.writeFileSync(victim, 'untouched\n');
      try {
        const res = await request(makeApp())
          .post('/api/review/apply-suggestion')
          .send({
            targetDir: tempDir,
            file: path.relative(tempDir, victim).replace(/\\/g, '/'),
            original: 'untouched',
            replacement: 'PWNED',
          });
        expect(res.status).toBe(400);
        expect(fs.readFileSync(victim, 'utf8')).toBe('untouched\n');
      } finally {
        fs.rmSync(victim, { force: true });
      }
    });
  });
});
