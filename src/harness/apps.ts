import type { AppManifest } from './types';

/**
 * What the model is told the ecosystem is. This is the hand-written seed; the
 * long-term source is each app's own manifest, generated and drift-checked.
 * Keep each entry to one line of role + a few capabilities: the model gets the
 * map, not the documentation.
 */
export const APP_MANIFESTS: AppManifest[] = [
  {
    id: 'openhub',
    name: 'OpenHub',
    kind: 'web',
    role: 'Operator console and harness host. Runs on the phone under Termux.',
    capabilities: ['chat', 'fleet', 'loops', 'audit', 'recourse proxy', 'research'],
    tools: [],
    health: 'http://127.0.0.1:3000/api/health',
    dataClass: 'private',
  },
  {
    id: 'agent-support',
    name: 'Agent Support',
    kind: 'android',
    role: 'Scoped memory hub, approvals and the phone-side point of reference.',
    capabilities: ['context', 'memory ingest', 'registry', 'MCP', 'approvals'],
    tools: ['memory.context', 'memory.ingest'],
    health: 'http://127.0.0.1:8766/api/ecosystem/health',
    dataClass: 'private',
  },
  {
    id: 'sieve',
    name: 'Sieve',
    kind: 'service',
    role: 'Telemetry spine and context compressor; aggregate events, no PHI.',
    capabilities: ['telemetry', 'recall', 'index', 'compress'],
    tools: ['telemetry.summary', 'sieve.recall'],
    health: 'https://telemetry.overlay365.online/health',
    dataClass: 'aggregate',
  },
  {
    id: 'recourse',
    name: 'Recourse',
    kind: 'service',
    role: 'Repair loop and tool factory: recall, forge, self-improvement.',
    capabilities: ['recall', 'ideas', 'forge', 'self-improvement', 'Kaggle compute'],
    tools: ['recourse.recall', 'recourse.ideas'],
    health: 'https://recourse.overlay365.online/api/recourse/health',
    dataClass: 'aggregate',
  },
  {
    id: 'concordance',
    name: 'Concordance',
    kind: 'android',
    role: 'Adjudication, referee, local Qwen and Kokoro voice on the device.',
    capabilities: ['adjudicate', 'local model', 'Kokoro TTS', 'referee'],
    tools: ['kokoro.speak', 'concordance.local_model'],
    health: null,
    dataClass: 'private',
  },
  {
    id: 'ecosystem-control',
    name: 'Ecosystem Control',
    kind: 'service',
    role: 'The clock: services, jobs/crons, runs, events, plans.',
    capabilities: ['services', 'crons', 'runs', 'plans', 'dispatch'],
    tools: ['fleet.status', 'fleet.service', 'cron.list'],
    health: 'https://ecosystem-control.tap4500.workers.dev/health',
    dataClass: 'aggregate',
  },
  {
    id: 'aetherdesk',
    name: 'AetherDesk',
    kind: 'service',
    role: 'Call centre, CRM and outreach; consumes research signals.',
    capabilities: ['CRM', 'campaigns', 'signals', 'subscriptions'],
    tools: ['aetherdesk.health'],
    health: 'https://api.overlay365.online/api/v1/signals/health',
    dataClass: 'private',
  },
];

export function appById(id: string): AppManifest | undefined {
  return APP_MANIFESTS.find((app) => app.id === id);
}
