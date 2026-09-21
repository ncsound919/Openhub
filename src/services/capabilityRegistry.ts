/**
 * Fleet Capability Registry.
 *
 * Modeled on FHIR CapabilityStatement and DataHub's MCP Service Catalog:
 * Every bridge in the fleet explicitly declares its identity, version specification,
 * liveness and readiness probe contracts, and the exact operations it supports.
 *
 * Probing is deterministic and honest: a bridge is never assumed to be "up"
 * without a successful probe, and probe outcomes are keyed to evidence receipts.
 */

export type BridgeCategory = 'core' | 'audit' | 'repair' | 'llm' | 'memory' | 'queue';
export type ProbeTransport = 'http' | 'tcp' | 'cli';

export interface BridgeIdentity {
  slug: string;
  name: string;
  category: BridgeCategory;
  transport: ProbeTransport;
  host?: string;
  port?: number;
  cliCommand?: string;
}

export interface BridgeProbeSpec {
  type: ProbeTransport;
  path?: string;
  port?: number;
  args?: string[];
  timeoutMs?: number;
  expectedStatus?: number;
}

export interface BridgeOperation {
  id: string;
  name: string;
  description: string;
  kind: 'query' | 'mutation' | 'stream';
  endpoint?: string;
  cliArgs?: string[];
}

export interface BridgeCapabilityStatement {
  identity: BridgeIdentity;
  versionSpec: {
    type: 'http' | 'cli';
    endpointOrArgs: string | string[];
  };
  liveness: BridgeProbeSpec;
  readiness: BridgeProbeSpec;
  operations: BridgeOperation[];
  documentation?: string;
}

export const FLEET_BRIDGES: Record<string, BridgeCapabilityStatement> = {
  axiom: {
    identity: {
      slug: 'axiom',
      name: 'Axiom Coding Harness',
      category: 'core',
      transport: 'http',
      host: '127.0.0.1',
      port: 3198,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/health',
    },
    liveness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'mission.run', name: 'Axiom Mission Run', description: 'Dispatch mission loop to autonomous harness', kind: 'mutation', endpoint: '/api/missions' },
      { id: 'composer.edit', name: 'Composer Multi-file Edit', description: 'Axiom composer multi-file edit loop', kind: 'mutation', endpoint: '/api/composer' },
      { id: 'test.execute', name: 'Sandbox Test Runner', description: 'Run test suite inside isolated execution sandbox', kind: 'mutation', endpoint: '/api/sandbox/run' },
    ],
    documentation: 'Axiom coding agent and multi-file code editing server.',
  },

  draymond: {
    identity: {
      slug: 'draymond',
      name: 'Draymond Orchestrator',
      category: 'repair',
      transport: 'http',
      host: '127.0.0.1',
      port: 3444,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/',
    },
    liveness: {
      type: 'http',
      path: '/',
      timeoutMs: 3000,
    },
    readiness: {
      type: 'http',
      path: '/',
      timeoutMs: 3000,
    },
    operations: [
      { id: 'orchestrate.workflow', name: 'Orchestrate Workflow', description: 'Top-level autonomous orchestration pipeline', kind: 'mutation', endpoint: '/api/workflows' },
    ],
    documentation: 'Fleet orchestration Next.js application.',
  },

  grader: {
    identity: {
      slug: 'grader',
      name: 'Grader Code Evaluator',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3201,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/healthz',
    },
    liveness: {
      type: 'http',
      path: '/api/healthz',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/readyz',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'audit.evaluate', name: 'Evaluate Code Quality', description: 'Run Grader AST & metric evaluation suite', kind: 'query', endpoint: '/api/evaluate' },
    ],
    documentation: 'Code quality and grade evaluation agent.',
  },

  reporank: {
    identity: {
      slug: 'reporank',
      name: 'RepoRank Scanner',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3200,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/health',
    },
    liveness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'repo.rank', name: 'Score Repository', description: 'Compute repository health rank and percentile', kind: 'query', endpoint: '/api/rank' },
      { id: 'repo.graph', name: 'Dependency Graph', description: 'Extract full dependency hierarchy and topology', kind: 'query', endpoint: '/api/graph' },
    ],
    documentation: 'Repository health ranker and dependency analyzer.',
  },

  'claw-protect': {
    identity: {
      slug: 'claw-protect',
      name: 'Claw-Protect Security Audit',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3300,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/health',
    },
    liveness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'security.audit', name: 'Security Audit', description: 'SAST vulnerability scanner and secret leak detector', kind: 'query', endpoint: '/api/audit' },
    ],
    documentation: 'Claw-Protect security auditing service.',
  },

  codenexus: {
    identity: {
      slug: 'codenexus',
      name: 'CodeNexus PR & Review Engine',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3205,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/health',
    },
    liveness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'pr.review', name: 'Review PR Diff', description: 'Autonomous pull request review and line commenting', kind: 'mutation', endpoint: '/api/review' },
    ],
    documentation: 'GitHub PR automated review and code improvement engine.',
  },

  'the-deep': {
    identity: {
      slug: 'the-deep',
      name: 'The Deep Audit Engine',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3100,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/v1/health',
    },
    liveness: {
      type: 'http',
      path: '/api/v1/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/v1/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'audit.static', name: 'Static Analysis', description: 'Deep static analysis pass over the target directory', kind: 'query', endpoint: '/api/v1/static-analysis' },
      { id: 'audit.taxonomy', name: 'Bug Taxonomy', description: 'Classify findings against the bug taxonomy', kind: 'query', endpoint: '/api/v1/bug-taxonomy' },
      { id: 'audit.intent', name: 'Deep Intent', description: 'Intent-level semantic audit of the changeset', kind: 'query', endpoint: '/api/v1/deep-intent' },
    ],
    documentation: 'The Deep audit engine backing the deep scorer.',
  },

  'vibe-reality': {
    identity: {
      slug: 'vibe-reality',
      name: 'Vibe-Reality Code Auditor',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3202,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/health',
    },
    liveness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'code.audit', name: 'Vibe Check Audit', description: 'Check runtime behavior and consistency assertions', kind: 'query', endpoint: '/api/check' },
    ],
    documentation: 'Vibe-Reality agent code auditor.',
  },

  mutly: {
    identity: {
      slug: 'mutly',
      name: 'Mutly Indexer & Daemon',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 4000,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/health',
    },
    liveness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'index.query', name: 'Query Code Index', description: 'Fast semantic and lexical index query across repos', kind: 'query', endpoint: '/api/search' },
    ],
    documentation: 'Mutly repository daemon and code indexer.',
  },

  'deterministic-brain': {
    identity: {
      slug: 'deterministic-brain',
      name: 'Deterministic Brain',
      category: 'core',
      transport: 'http',
      host: '127.0.0.1',
      port: 3210,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/health',
    },
    liveness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'plan.compute', name: 'Deterministic Plan', description: 'Compute non-hallucinatory repair strategy graph', kind: 'mutation', endpoint: '/api/plan' },
    ],
    documentation: 'Rule-based deterministic planning engine in Python.',
  },

  litellm: {
    identity: {
      slug: 'litellm',
      name: 'LiteLLM Proxy',
      category: 'llm',
      transport: 'http',
      host: '127.0.0.1',
      port: 4100,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/health',
    },
    liveness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'llm.complete', name: 'LLM Chat Completion', description: 'Universal OpenAI-compatible LLM router and fallbacks', kind: 'mutation', endpoint: '/chat/completions' },
    ],
    documentation: 'Local LLM proxy routing to Ollama/DeepSeek/Gemini/Anthropic.',
  },

  redis: {
    identity: {
      slug: 'redis',
      name: 'Redis Queue',
      category: 'queue',
      transport: 'tcp',
      host: '127.0.0.1',
      port: 6379,
    },
    versionSpec: {
      type: 'cli',
      endpointOrArgs: ['redis-server', '--version'],
    },
    liveness: {
      type: 'tcp',
      port: 6379,
      timeoutMs: 1500,
    },
    readiness: {
      type: 'tcp',
      port: 6379,
      timeoutMs: 1500,
    },
    operations: [
      { id: 'queue.task', name: 'Enqueue Background Task', description: 'BullMQ and Celery async message broker', kind: 'mutation' },
    ],
    documentation: 'Redis memory store and asynchronous message queue.',
  },

  'dev-brain': {
    identity: {
      slug: 'dev-brain',
      name: 'Dev-Brain Fleet Triage',
      category: 'core',
      transport: 'http',
      host: '127.0.0.1',
      port: 3450,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/health',
    },
    liveness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'fleet.triage', name: 'Triage Issue', description: 'Intake and classify incoming developer bug or task', kind: 'mutation', endpoint: '/api/triage' },
    ],
    documentation: 'Dev-Brain triage and developer task intake gateway.',
  },

  recourse: {
    identity: {
      slug: 'recourse',
      name: 'Recourse Self-Learning',
      category: 'memory',
      transport: 'http',
      host: '127.0.0.1',
      port: 3050,
    },
    versionSpec: {
      type: 'http',
      endpointOrArgs: '/api/v1/health',
    },
    liveness: {
      type: 'http',
      path: '/api/v1/health',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/v1/health',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'memory.recall', name: 'Recall Lessons', description: 'Semantic recall over past verified lessons and fixes', kind: 'query', endpoint: '/api/v1/memory/recall' },
      { id: 'memory.index', name: 'Index Verified Fix', description: 'Store newly verified repair episode into collective memory', kind: 'mutation', endpoint: '/api/v1/memory/index' },
      { id: 'synergy.map', name: 'Synergy Domains', description: 'Cross-agent domain capability synergy matrix', kind: 'query', endpoint: '/api/v1/synergy' },
    ],
    documentation: 'Recourse self-learning, cross-agent memory, and capability forge.',
  },
};

export function getBridgeStatement(slug: string): BridgeCapabilityStatement | undefined {
  return FLEET_BRIDGES[slug];
}

export function listBridgeStatements(): BridgeCapabilityStatement[] {
  return Object.values(FLEET_BRIDGES);
}
