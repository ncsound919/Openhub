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
      endpointOrArgs: '/health/liveliness',
    },
    liveness: {
      type: 'http',
      path: '/health/liveliness',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/health/liveliness',
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
      endpointOrArgs: '/api/recourse/scheduler',
    },
    liveness: {
      type: 'http',
      path: '/api/recourse/scheduler',
      timeoutMs: 2500,
    },
    readiness: {
      type: 'http',
      path: '/api/recourse/scheduler',
      timeoutMs: 2500,
    },
    operations: [
      { id: 'memory.recall', name: 'Recall Lessons', description: 'Semantic recall over past verified lessons and fixes', kind: 'query', endpoint: '/api/v1/memory/recall' },
      { id: 'memory.index', name: 'Index Verified Fix', description: 'Store newly verified repair episode into collective memory', kind: 'mutation', endpoint: '/api/v1/memory/index' },
      { id: 'synergy.map', name: 'Synergy Domains', description: 'Cross-agent domain capability synergy matrix', kind: 'query', endpoint: '/api/v1/synergy' },
    ],
    documentation: 'Recourse self-learning, cross-agent memory, and capability forge.',
  },

  omniresearch: {
    identity: {
      slug: 'omniresearch',
      name: 'OmniResearch 2',
      category: 'audit',
      transport: 'http',
      host: '127.0.0.1',
      port: 3012,
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
      { id: 'research.ask', name: 'Research Ask', description: 'LiteLLM synthesis for a research question', kind: 'mutation', endpoint: '/api/llm/research' },
      { id: 'research.deep', name: 'Deep Deterministic Research', description: 'Big-10 skill dossier with provenance logs', kind: 'mutation', endpoint: '/api/agent/deep-deterministic-research' },
      { id: 'research.harvest', name: 'Multi-Source Harvest', description: 'ArXiv + OpenAlex + Wikipedia + PubMed', kind: 'query', endpoint: '/api/integrations/multi-harvest' },
      { id: 'research.autonomous', name: 'Autonomous Research Loop', description: 'Topic convergence loop with SHA-256 proof', kind: 'mutation', endpoint: '/api/research/autonomous-loop' },
      { id: 'dag.plan', name: 'Big-10 DAG Plan', description: 'Seven-node deterministic research graph plan', kind: 'mutation', endpoint: '/api/agent/big10/plan-dag' },
      { id: 'dag.execute', name: 'Big-10 DAG Execute', description: 'Run the planned DAG with MMR + audit', kind: 'mutation', endpoint: '/api/agent/big10/execute-dag' },
      { id: 'baseline.sources', name: 'Baseline Sources', description: 'Query the 110-authority research site registry', kind: 'query', endpoint: '/api/agent/baseline-sources' },
      { id: 'jev.decision', name: 'JEV Decision', description: 'Deterministic JEV + Dev-Brain System One advisory', kind: 'mutation', endpoint: '/api/gateway/jev-decision' },
      { id: 'llama.generate', name: 'Local Model Generate', description: 'Air-gapped llama.cpp lane (never fakes cloud)', kind: 'mutation', endpoint: '/api/llama/generate' },
      { id: 'mcp.tools', name: 'MCP Tools', description: 'JSON-RPC tools/list + tools/call', kind: 'mutation', endpoint: '/api/mcp' },
      { id: 'pipeline.unified', name: 'Unified Research Media', description: 'Dossier + slides + infographic pipeline', kind: 'mutation', endpoint: '/api/pipeline/unified-research-media' },
      { id: 'ecosystem.axiom-repair', name: 'Dispatch Axiom Repair', description: 'Hand Axiom a project loop via Recourse bridge', kind: 'mutation', endpoint: '/api/ecosystem/axiom-repair' },
    ],
    documentation: 'OmniResearch 2 deep-research agent (LiteLLM :4100, MCP at /api/mcp). Port 3012 — 3010 is OpenHub.',
  },

  // Jarvis / OpenJarvis - the fleet's local-first assistant.
  //
  // CLI transport, deliberately. Jarvis is a Python application with no
  // HTTP service of its own: its FastAPI server is how the browser UI talks
  // to it, and that server's configured port (8000, from
  // ~/.openjarvis/config.toml `[server] port`) is held by
  // com.docker.backend.exe on this host, so an HTTP liveness probe would
  // answer 200 for DOCKER while Jarvis itself is not running. That is the
  // wrong-service false positive this registry exists to avoid, so the probe
  // runs the interpreter directly and proves the import works.
  //
  // The liveness command is `import openjarvis` rather than `jarvis --version`
  // because the console script boots the whole CLI (measured 15.4s) while the
  // import completes in ~0.3s. Importing is also the stronger check: it pulls
  // in the mandatory openjarvis-rust PyO3 extension, which raises a hard
  // ImportError when the native build is missing.
  jarvis: {
    identity: {
      slug: 'jarvis',
      name: 'Jarvis Assistant (OpenJarvis)',
      category: 'core',
      transport: 'cli',
      cliCommand:
        process.env.OPENHUB_JARVIS_PYTHON ||
        'C:/Users/User/AppData/Local/OpenJarvis/src/.venv/Scripts/python.exe',
    },
    versionSpec: {
      type: 'cli',
      endpointOrArgs: ['-c', 'import openjarvis;print(openjarvis.__version__)'],
    },
    liveness: {
      type: 'cli',
      args: ['-c', 'import openjarvis;print(openjarvis.__version__)'],
      timeoutMs: 15_000,
    },
    readiness: {
      // Heavy on purpose, and NOT run by probeBridge (which only ever executes
      // `liveness`). Synthesizing real audio is the only proof that the Kokoro
      // TTS lane works end to end, and it costs ~20s loading model weights
      // plus the espeak-ng G2P fallback.
      type: 'cli',
      args: [
        '-c',
        "from openjarvis.speech.kokoro_tts import KokoroTTSBackend as B; b=B(); print('tts-health', b.health())",
      ],
      timeoutMs: 180_000,
    },
    operations: [
      { id: 'agent.ask', name: 'Ask Jarvis', description: 'Ask Jarvis a question on its local llama.cpp lane', kind: 'query', cliArgs: ['ask'] },
      { id: 'doctor.check', name: 'Environment Doctor', description: 'Python version, engine reachability, speech backend, Node.js', kind: 'query', cliArgs: ['doctor'] },
      { id: 'speech.synthesize', name: 'Synthesize Speech', description: 'Synthesize speech from text with the local Kokoro TTS backend', kind: 'mutation', cliArgs: ['chat', '--voice'] },
      { id: 'tool.openhub', name: 'OpenHub Tool Round-Trip', description: 'Jarvis invoking OpenHub audit tools through its own MCP registration', kind: 'query' },
    ],
    documentation:
      'Jarvis (OpenJarvis) local-first assistant: llama.cpp reasoning, Kokoro TTS + faster-whisper voice, OpenHub as an MCP tool provider. Probed over its venv interpreter; no HTTP port of its own.',
  },
};

export function getBridgeStatement(slug: string): BridgeCapabilityStatement | undefined {
  return FLEET_BRIDGES[slug];
}

export function listBridgeStatements(): BridgeCapabilityStatement[] {
  return Object.values(FLEET_BRIDGES);
}
