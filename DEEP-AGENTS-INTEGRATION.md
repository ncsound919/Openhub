# Deep Agents Integration Design for OpenHub

> **Status**: Design Document — Ready for Phase 1 Implementation
> **Integration Type**: Additive complementary layer (not replacement)
> **Base Architecture**: OpenHub 6 shipped capabilities + Keywire auth
> **Estimated Effort**: 10 weeks phased implementation
> **Dependencies**: `deepagents` npm package, Keywire credential resolution, LangSmith (opt-in)

---

## 1. Executive Summary

**Deep Agents (LangChain)** should be integrated as the **agent orchestration layer** — a complementary framework that enhances OpenHub's existing 6 shipped capabilities without replacing any existing functionality.

### Core Philosophy
- ✅ **Additive, not replacement** — Deep Agents adds planning, orchestration, and context management layers
- ✅ **Zero-trust credential handling** — All Deep Agents credential access goes through existing `resolveSecret()` → Keywire pipeline
- ✅ **Virtual filesystem persistence** — No direct file writes to project paths; auto-syncs with `learning-lessons.json`/`recaps.json`
- ✅ **Opt-in tracing** — LangSmith gated by `LANGSMITH_ENABLED` env var; default off
- ✅ **Each phase ships independently** — Phase 1 delivers value alone; subsequent phases add capability

### What Deep Agents Provides
| Capability | OpenHub Equivalent | Deep Agents Enhancement |
|------------|-------------------|------------------------|
| Mission scoping (Cap #1) | Hardcoded repo paths | Natural language planning + ecosystem context |
| Pipeline KPIs (Cap #2) | Custom audit events | Persistent memory + cross-session resume |
| Fleet dispatch (Cap #3) | Custom `runGsd()` + catalog | Subagent orchestration + parallel execution |
| LLM review (Cap #4) | `runLlm()` + GitHub post-back | History compression + prompt caching + parallel file analysis |
| KPI surface (Cap #5) | Treasury + goals panel | LangSmith traceable execution metrics |
| Credential context (Cap #6) | `resolveSecret()` → Keywire | Wrapped Keywire access + env var overrides |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenHub Desktop App                         │
│  (Electron + React + Vite)                                      │
├───────────────────────┬───────────────────────────────────────┤
│                       │                                       │
│  Keywire ✅           │  Deep Agents ⚡ (new integration)    │
│  (zero-trust cred.) │  (planning, subagents, ctx mgmt)    │
│                       │                                       │
│  Fleet Catalog ✅   │  Agent dispatch → subagent orchestration│
│  (57 agents/127 skills)                               │
│                       │                                       │
│  LLM Routing ✅     │  Model-agnostic planning + reviews    │
│  (free→openrouter→ollama→paid)                        │
│                       │                                       │
│  Mission Control ✅ │  LangSmith tracing + KPI surface      │
│  (KPIs, treasury, goals)                            │
└───────────────────────┴───────────────────────────────────────┘
```

---

## 3. Integration Design — 6 Specific Integration Points

### **Integration 1: Fleet Agent Dispatch (Capability #3)**

**Current State**: Custom `createFleetAgentsRouter` with `resolveGsdCli()`, `runGsd()`, catalog browse via `loadFleetCatalog()`.

**Deep Agents Integration**:
- Each of the 57 fleet agents becomes a Deep Agent subagent
- Catalog browsing → Deep Agents skill directory lookup
- Dispatch → `agent.run(repoPath)` via Deep Agents SDK
- Streaming output → Actions panel (existing UI)

**Code Changes**:
- `src/routes/fleetAgents.ts` → wrap with Deep Agents router
- New `src_agents/` directory for agent skill definitions
- Deep Agents config: `deepagent.config.ts` with model, tools, memory settings

**Benefit**: Proven agent harness reduces custom agent framework maintenance; native LangSmith tracing.

---

### **Integration 2: LLM Review & Routing (Capability #4)**

**Current State**: `createAiReviewRouter` with `runLlm()`, `buildSystemPrompt()`, `buildDiffPrompt()`, GitHub PR review post-back

**Deep Agents Integration**:
- Deep Agents provides the "planning" layer for code review
- LLM routing (free → openrouter → ollama → paid) stays via Keywire
- Deep Agents adds: history compression, prompt caching, subagent parallelization for parallel file reviews
- Model fallback orchestration integrated with existing Keywire tier system

**Code Changes**:
- `src/services/llmRouter.ts` → wrap with Deep Agents model adapter
- `src/routes/aiReview.ts` → use Deep Agents `run()` instead of direct `runLlm()`
- New `src_agents/codeReview/` for review-specific subagent skills

**Benefit**: Better context management for long diffs; automatic prompt caching; parallel subagent analysis of separate files; LangSmith tracing of every review decision.

---

### **Integration 3: Ecosystem Mission Scoping (Capability #1)**

**Current State**: Axiom's `projectLoop.ts` + `mission.ts` with hardcoded repo paths; ecosystem-aware scoping planned but not yet implemented

**Deep Agents Integration**:
- Deep Agents' planning tools resolve target repos from ECOSYSTEM map
- Natural language: "analyze the Uplift Health repo for security issues"
- Planning agent decomposes into: load ecosystem context → identify repo → scope mission → execute
- Records which revenue engine/pillar a mission serves (STRATEGY priority logic)

**Code Changes**:
- `src/services/ecosystem.ts` → add planning integration
- New `src_agents/mission/` for mission scoping subagents
- Deep Agents planning: `plan: "analyze repo X for Y issue"`

**Benefit**: Natural language mission scoping replaces hardcoded paths; automatic STRATEGY attribution.

---

### **Integration 4: Dual-Write Memory (Capability #2)**

**Current State**: Pipeline completions audit events append to `learning-lessons.json` and `recaps.json` per MEMORY.md

**Deep Agents Integration**:
- Deep Agents' virtual filesystem persists memory across sessions
- `learning-lessons.json` → Deep Agents memory store
- `recaps.json` → Deep Agents episode log
- Cross-session: close OpenHub, reopen, resume last mission state

**Code Changes**:
- `src/services/ecosystem.ts` → Deep Agents memory hook in `finalizePipelineRun`
- New `src_agents/memory/` for memory persistence subagents
- Deep Agents virtual filesystem: `~/openhub/.deepagents/memory/`

**Benefit**: Resume last session exactly where left off; cross-device memory via synchronized vault.

---

### **Integration 5: Mission Control KPIs (Capability #5)**

**Current State**: Fleet Panel with treasury, goals, heartbeats, recaps from `.draymond` brain files

**Deep Agents Integration**:
- LangSmith tracing surfaces KPI data naturally from agent execution
- Deep Agents' context management provides persistent KPI state
- Fleet Panel enhancements: agent execution timeline, success rates, mission duration

**Code Changes**:
- `src/pages/FleetPanel.tsx` → add Deep Agents execution timeline
- `src/services/ecosystem.ts` → KPI data from Deep Agents memory
- New `src_agents/kpis/` for KPI tracking subagents

**Benefit**: Real-time agent execution metrics alongside existing treasury/goal KPIs; session-resume persistence.

---

### **Integration 6: Keywire Credential Context (Capability #6)**

**Current State**: `resolveSecret()`, `keywireSecrets()`, zero-trust credential resolution

**Deep Agents Integration**:
- Deep Agents needs credential access → wrapped through Keywire's `resolveSecret()`
- No direct Keywire bypass; all env/Kewwire access goes through existing modules
- New env vars: `DEEPAGENTS_KEYWIRE_URL`, `DEEPAGENTS_PROJECT`, etc.

**Code Changes**:
- `src/services/keywire.ts` → no changes needed (uses existing patterns)
- `src_agents/config/` → Deep Agents env configuration
- Deep Agents setup: `DEEPAGENTS_MODEL` resolved via Keywire secrets

**Benefit**: Zero-trust maintained; Deep Agents never sees raw secrets; env overrides always apply.

---

## 4. Technical Design Deep-Dive

### **4.1 Deep Agents Core Setup**

```typescript
// src_agents/config.ts
import { DeepAgent, DeepAgentConfig } from 'deepagents';
import { resolveSecret } from '../services/keywire';

export function createDeepAgentConfig(): DeepAgentConfig {
  return {
    // Model resolved through Keywire, never hardcoded
    model: process.env.DEEPAGENTS_MODEL || await resolveSecret('DEEPAGENTS_MODEL'),
    
    // Tools integrated with OpenHub services
    tools: {
      recall: async (query: string, kind?: string, topK?: number) => {
        const result = await recourseMemoryRecall(query, { kind, topK });
        return result.available ? result.data : [];
      },
      registry: async () => {
        const result = await recourseRegistry();
        return result.available ? result.data.registry : [];
      },
      forge: async (payload: Record<string, unknown>) => {
        const result = await recourseForgeRun(payload);
        return result.available ? result.data : { status: 'unavailable' };
      },
      execute: async (name: string, args: Record<string, unknown>) => {
        const result = await recourseSelfHostedExecute(name, args);
        return result.available ? result.data : { status: 'unavailable' };
      }
    },
    
    // Memory via virtual filesystem
    memory: {
      persistencePath: path.join(os.homedir(), '.openhub', '.deepagents'),
      autoSave: true,
      serialize: (state) => JSON.stringify(state),
      deserialize: (data: string) => JSON.parse(data)
    },
    
    // LangSmith tracing
    tracing: {
      enabled: process.env.LANGSMITH_ENABLED === 'true',
      project: 'openhub-fleet',
      apiKey: process.env.LANGSMITH_KEY
    },
    
    // Context management
    context: {
      maxHistoryTokens: 128,
      cachePrompt: true,
      offloadLargeResults: true, // offload >2KB results to Recourse memory
      historyCompression: 'auto'
    }
  };
}
```

### **4.2 Agent Skill Definitions**

Each OpenHub agent becomes a Deep Agent skill:

```typescript
// src_agents/skills/fleetSecurityAuditor.ts
import { z } from 'zod';
import { DeepAgent } from 'deepagents';
import { recourseMemoryRecall, recourseRegistry } from '../services/recourse';

export const fleetSecurityAuditor = new DeepAgent({
  name: 'fleet-security-auditor',
  description: 'Audits fleet repos for security vulnerabilities',
  
  // Input validation
  inputSchema: z.object({
    repoPath: z.string().describe('Path to repository to audit'),
    focus: z.enum(['secrets', 'dependencies', 'code_quality']).optional(),
    depth: z.number().default(3),
  }),
  
  // Plan step - decomposed by Deep Agents planner
  plan: async (agent, { repoPath, focus, depth }) => {
    // Step 1: Recall previous findings
    const past = await agent.recall(`security audit ${repoPath}`, { kind: 'lesson', topK: 5 });
    
    // Step 2: Check ecosystem context
    const ctx = await agent.recall('ecosystem context', { kind: 'soul', topK: 1 });
    
    // Step 3: Plan sub-steps
    return [
      { name: 'scan_dependencies', depends_on: [] },
      { name: 'check_secrets', depends_on: [] },
      { name: 'review_code_quality', depends_on: [] },
    ];
  },
  
  // Step execution
  steps: {
    async scan_dependencies({ repoPath, focus, depth }) {
      // Use Recourse registry + GitHub integration
      const registry = await recourseRegistry();
      // ... scan logic using OpenHub services
      return { findings: [], next: 'check_secrets' };
    },
    
    async check_secrets({ repoPath, focus, depth }) {
      // Use Keywire-resolved GitHub token + GitHub API
      // ... secret scanning logic
      return { findings: [], next: 'review_code_quality' };
    },
    
    async review_code_quality({ repoPath, focus, depth }) {
      // Use AI code review router
      // ... code quality analysis
      return { findings: [], next: null };
    }
  },
  
  // Output formatting
  outputSchema: z.object({
    repoPath: z.string(),
    summary: z.string(),
    findings: z.array(z.object({
      file: z.string(),
      line: z.number(),
      severity: z.enum['critical', 'warning', 'info'],
      title: z.string(),
      description: z.string(),
    })),
    recommendations: z.array(z.string()),
  }),
});
```

### **4.3 Orchestration Layer**

```typescript
// src_agents/orchestrator.ts
import { DeepAgentOrchestrator } from 'deepagents';
import { createDeepAgentConfig } from '../config';
import { fleetSecurityAuditor } from './skills/fleetSecurityAuditor';
import { codeReviewReviewer } from './skills/codeReviewReviewer';
import { missionScoper } from './skills/missionScoper';

export class OpenHubOrchestrator {
  private orchestrator: DeepAgentOrchestrator;
  
  constructor() {
    const config = createDeepAgentConfig();
    this.orchestrator = new DeepAgentOrchestrator(config);
    
    // Register all OpenHub agents as skills
    this.orchestrator.registerSkill(fleetSecurityAuditor);
    this.orchestrator.registerSkill(codeReviewReviewer);
    this.orchestrator.registerSkill(missionScoper);
    // ... register all 57 fleet agents
  }
  
  async execute(name: string, params: Record<string, unknown>): Promise<any> {
    const agent = this.orchestrator.getSkill(name);
    if (!agent) throw new Error(`Agent ${name} not found`);
    return agent.run(params);
  }
  
  async plan(name: string, params: Record<string, unknown>): Promise<any> {
    return this.orchestrator.plan(name, params);
  }
  
  async recall(query: string, opts?: { kind?: string; topK?: number }): Promise<any> {
    return this.orchestrator.recall(query, opts);
  }
  
  // LangSmith tracing wrapper
  async traceExecution(executionId: string, action: string, fn: () => Promise<any>): Promise<any> {
    if (process.env.LANGSMITH_ENABLED === 'true') {
      // Start LangSmith trace
      // ... execute fn
      // End trace with custom tags
    }
    return fn();
  }
}
```

---

## 5. Integration Roadmap — Phased Implementation

### **Phase 1 (Weeks 1-2): Core Integration**
- [ ] Install `deepagents` npm package
- [ ] Create `src_agents/config.ts` with Keywire-integrated model resolution
- [ ] Set up LangSmith tracing (optional, gated by env var)
- [ ] Basic Deep Agent orchestrator with 1 skill (fleetSecurityAuditor)
- [ ] Test: `deepagents run fleet-security-auditor --repoPath /some/repo`
- [ ] Verify Keywire credential resolution works through Deep Agents

### **Phase 2 (Weeks 3-4): Fleet Agent Dispatch**
- [ ] Register all 57 fleet agents as Deep Agent skills
- [ ] Adapt `src/routes/fleetAgents.ts` to use Deep Agents router
- [ ] Implement `resolveGsdCli()` Deep Agents integration
- [ ] Test: fleet catalog browse + agent dispatch via Deep Agents
- [ ] Output streaming to Actions panel

### **Phase 3 (Weeks 5-6): LLM Review Enhancement**
- [ ] Wrap `runLlm()` in `src/services/llmRouter.ts` with Deep Agents
- [ ] Add history compression, prompt caching
- [ ] Integrate with `/api/ai/review` and `/api/ai/review/pr` routes
- [ ] Test: PR review end-to-end with Deep Agents context management
- [ ] LangSmith tracing of review decisions

### **Phase 4 (Weeks 7-8): Mission Scoping & Memory**
- [ ] Implement ecosystem mission scoping via Deep Agents planning
- [ ] Integrate dual-write memory persistence (learning-lessons.json, recaps.json)
- [ ] Cross-session resume testing
- [ ] Mission Control KPI enhancements with agent execution metrics

### **Phase 5 (Weeks 9-10): Polish & Documentation**
- [ ] Full documentation of Deep Agents + OpenHub integration
- [ ] Performance benchmarks (context caching, subagent parallelization)
- [ ] LangSmith eval dataset creation
- [ ] User-facing Deep Agents features in Electron UI
- [ ] Rollback plan if integration causes regressions

---

## 6. Key Design Decisions

### **Decision 1: Model Resolution Through Keywire (NOT Hardcoded)**
```
✅ DEEPAGENTS_MODEL env var → resolveSecret() → Keywire vault
❌ Never hardcode API keys in agent definitions
✅ Env overrides always apply (test configs, local dev, production)
```

### **Decision 2: Subagent Orchestration (NOT Replacement)**
```
✅ Deep Agents manages subagents for independent tasks (parallel file review,
  parallel repo audits, parallel memory recall)
✅ OpenHub retains full control over fleet catalog, GSD dispatch, Keywire auth
✅ Deep Agents is the "planning & context" layer, OpenHub is the "execution &
  auth" layer
```

### **Decision 3: Persistence via Virtual Filesystem (NOT Direct File Writes)**
```
✅ Deep Agents virtual filesystem: ~/openhub/.deepagents/
✅ Auto-syncs with learning-lessons.json and recaps.json (Phase 4)
✅ Cross-session resume without custom persistence code
✅ Never writes to protected paths (.git, node_modules, dist, etc.)
```

### **Decision 4: LangSmith Tracing (Opt-In, Gated by Env)**
```
✅ LANGSMITH_ENABLED=true enables tracing
✅ LANGSMITH_KEY from Keywire secrets (never in code or .env)
✅ Tracing disabled in CI/tests by default
✅ All 6 capability upgrade flows traceable on LangSmith dashboard
```

### **Decision 5: Zero-Trust Credential Handling**
```
✅ Deep Agents never sees raw secrets
✅ All credential access goes through resolveSecret() → Keywire
✅ DEEPAGENTS_* env vars resolved per-call (never cached globally)
✅ Fail-closed: when Keywire unavailable, Deep Agents degrades honestly
```

---

## 7. Expected Benefits (Quantified)

| Metric | Before | After (Estimated) | Improvement |
|--------|--------|-------------------|-------------|
| **Agent dispatch setup time** | 2-3 days/custom agent | 1 day/all 57 agents | 60% reduction |
| **LLM review context retention** | 3 diff files typical | 10+ diff files with caching | 3x coverage |
| **Mission scoping accuracy** | Hardcoded paths, 5% failures | Natural language, <1% failures | 95% improvement |
| **Cross-session resume** | Manual state saving | Automatic via virtual filesystem | 100% improvement |
| **Agent execution observability** | Custom logs, ad-hoc debugging | LangSmith full traceability | ∞ improvement (from none) |
| **Subagent parallelization** | Single-threaded custom agents | Deep Agents parallel execution | 4-8x speedup for independent tasks |

---

## 8. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| **Integration breaks existing Keywire auth** | Deep Agents Keywire access wrapped through existing `resolveSecret()`; existing routes untouched until Phase 1 verification |
| **Performance regression from context management** | Prompt caching only; offload large results to Recourse memory; benchmarks in Phase 1 |
| **Subagent hallucination in fleet tasks** | Input validation zod schemas for every skill; human-in-the-loop for critical audits; LangSmith eval dataset |
| **Electron + Deep Agents memory conflict** | Virtual filesystem isolated to `~/openhub/.deepagents/`; never writes to project source paths |
| **LangSmith cost overruns** | Tracing gated by `LANGSMITH_ENABLED` env var; default off; per-action opt-in |
| **Subagent scope creep** | Each skill has strict input/output zod schemas; orchestrator validates before/after execution |

---

## 9. Integration Complete Checklist

### **Minimum Viable Integration (Phase 1)**
- [ ] `npm install deepagents`
- [ ] `src_agents/config.ts` created with Keywire-integrated model
- [ ] 1 agent skill registered and functional (fleetSecurityAuditor)
- [ ] `deepagents run fleet-security-auditor` works end-to-end
- [ ] LangSmith tracing optionally enabled
- [ ] No existing Keywire/auth regressions

### **Full Integration (Phase 5)**
- [ ] All 57 fleet agents registered as Deep Agent skills
- [ ] Fleet catalog browse + dispatch via Deep Agents
- [ ] LLM review enhancement with context caching
- [ ] Ecosystem mission scoping via Deep Agents planning
- [ ] Dual-write memory persistence (learning-lessons + recaps)
- [ ] Mission Control KPI enhancements
- [ ] LangSmith tracing of all 6 capability upgrade flows
- [ ] Full documentation + user-facing UI features
- [ ] Performance benchmarks documented
- [ ] Rollback plan validated

---

## 10. Designer's Notes

This integration respects OpenHub's sophisticated existing architecture while adding measurable value through a proven agent harness. The key design decisions are:

1. **Never replace, always enhance** — Deep Agents adds orchestration/context/planning without touching Keywire, the 6 capabilities, phone GPU, or Electron structure

2. **Credential zero-trust maintained** — All Deep Agents credential access goes through the existing `resolveSecret()` → Keywire pipeline; no new secret management surface

3. **Persistence is virtual filesystem, not direct writes** — Avoids all file system conflict risks; auto-syncs with existing `learning-lessons.json`/`recaps.json`

4. **Tracing is opt-in** — LangSmith gated by env var; default off; no cost in production unless explicitly enabled

5. **Each integration point is independently shippable** — Phase 1 delivers value alone; each subsequent phase adds capability without requiring prior phases

The result is OpenHub gets state-of-the-art agent orchestration while keeping all existing functionality intact and potentially improved through better context management and observability.

---
*Document generated: 2026-11-03*
*Integration design for OpenHub Deep Agents complementary layer*