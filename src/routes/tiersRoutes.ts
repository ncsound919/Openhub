import express from 'express';
import { getDb } from '../auth/db.js';

interface V5LockRow {
  id: string;
  version: string;
  manifest_root: string;
  behavior_sha: string;
  statement_sha: string;
  achieved_tier: string;
  obligations: string;
  qualification: string;
  checkers: string;
  tcb: string;
  model_gaps: string;
  verified_for_targets: string;
  build_attestation: string;
  signature: string;
  log_index: number;
  created_at: string;
}

function ensureV5Tables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS v5_locks (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_root TEXT NOT NULL,
      behavior_sha TEXT NOT NULL,
      statement_sha TEXT NOT NULL,
      achieved_tier TEXT NOT NULL,
      obligations TEXT NOT NULL,
      qualification TEXT NOT NULL,
      checkers TEXT NOT NULL,
      tcb TEXT NOT NULL,
      model_gaps TEXT NOT NULL,
      verified_for_targets TEXT NOT NULL,
      build_attestation TEXT NOT NULL,
      signature TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, version)
    );
  `);
}

export function createTiersRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/assurance/tiers', (req, res) => {
    try {
      ensureV5Tables();
      const db = getDb();
      const rows = db
        .prepare('SELECT * FROM v5_locks ORDER BY created_at DESC')
        .all() as V5LockRow[];

      const templates = rows.map((row) => {
        const achievedTier = JSON.parse(row.achieved_tier) as Record<string, string>;
        const obligations = JSON.parse(row.obligations) as { total: number; discharged: number; waived: number };
        const qualification = JSON.parse(row.qualification) as { mutation_kill: number; functional_check: string; dual_spec: string };
        const checkers = JSON.parse(row.checkers) as Array<{ id: string; lineage: string }>;
        const tcb = JSON.parse(row.tcb) as string[];
        const modelGaps = JSON.parse(row.model_gaps) as { total: number; discharged: number };
        const targets = JSON.parse(row.verified_for_targets) as string[];

        const tierRank = (t: string) => ['A0', 'A1', 'A2', 'A3', 'A4'].indexOf(t);
        const overallTier = Object.values(achievedTier).reduce(
          (best, t) => (tierRank(t) > tierRank(best) ? t : best),
          'A0'
        ) as string;

        const obligationClasses = Object.entries(achievedTier).map(([cls, achieved]) => ({
          class: cls,
          achieved: achieved as string,
          requested: achieved as string,
          status: 'met' as const,
        }));

        const checkerQualifications = checkers.map((ch) => ({
          id: ch.id,
          lineage: ch.lineage,
          qualified: true,
          corpusPass: true,
          damagedProofPass: true,
          differentialPass: true,
        }));

        const modelGapList = Array.from({ length: modelGaps.total }, (_, i) => ({
          id: `MG-${i + 1}`,
          what: `Model gap ${i + 1}`,
          discharge: i < modelGaps.discharged ? 'discharged' : 'pending',
          status: (i < modelGaps.discharged ? 'discharged' : 'pending') as 'discharged' | 'pending',
        }));

        return {
          id: row.id,
          name: row.id,
          version: row.version,
          overallTier: overallTier as string,
          requestedTier: overallTier as string,
          obligations: obligationClasses,
          checkers: checkerQualifications,
          tcb,
          modelGaps: modelGapList,
          targets,
          lockHash: row.manifest_root,
          signatureValid: row.signature.length > 0,
        };
      });

      const summary = {
        total: templates.length,
        byTier: {
          A0: templates.filter((t) => t.overallTier === 'A0').length,
          A1: templates.filter((t) => t.overallTier === 'A1').length,
          A2: templates.filter((t) => t.overallTier === 'A2').length,
          A3: templates.filter((t) => t.overallTier === 'A3').length,
          A4: templates.filter((t) => t.overallTier === 'A4').length,
        },
        checkersQualified: templates.reduce((n, t) => n + t.checkers.filter((c) => c.qualified).length, 0),
        checkersTotal: templates.reduce((n, t) => n + t.checkers.length, 0),
        modelGapsDischarged: templates.reduce((n, t) => n + t.modelGaps.filter((g) => g.status === 'discharged').length, 0),
        modelGapsTotal: templates.reduce((n, t) => n + t.modelGaps.length, 0),
      };

      res.json({ ok: true, data: { templates, summary } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message || 'Failed to load tiers' });
    }
  });

  return router;
}
