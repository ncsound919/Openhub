import { addMessage, addToolCall, createApproval, listMessages } from './store';
import { buildSystemPrompt, loadLiveState } from './systemMap';
import { TOOLS, executeTool, requiresApproval, toolByName } from './tools';
import { publish } from './events';
import type { ApprovalRecord, HarnessAction, ToolResult } from './types';
import { runLlm, type LlmMessage } from '../services/llmRouter';

/**
 * The loop: plan → tool → observe → answer. A 4B is kept honest with three
 * constraints: a strict JSON schema, a short tool list, and a hard step cap.
 */

export const MAX_TOOL_STEPS = 3;

/** Strict envelope. All fields required; `null` is how "not needed" is said. */
export const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'say', 'tool', 'args', 'plan'],
  properties: {
    type: { type: 'string', enum: ['tool', 'final', 'ask', 'plan'] },
    say: { type: 'string' },
    tool: { type: ['string', 'null'] },
    args: {
      type: 'object',
      additionalProperties: false,
      required: ['service', 'window', 'limit', 'job', 'title', 'steps', 'budget_usd'],
      properties: {
        service: { type: ['string', 'null'] },
        window: { type: ['string', 'null'] },
        limit: { type: ['integer', 'null'] },
        job: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        steps: { type: ['string', 'null'] },
        budget_usd: { type: ['number', 'null'] },
      },
    },
    plan: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['title', 'steps'],
      properties: {
        title: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

interface Completion {
  ok: boolean;
  text?: string;
  tier?: 'local' | 'gateway' | 'edge';
  error?: string;
}

let stateCache: { at: number; value: string } | null = null;

async function liveState(env: NodeJS.ProcessEnv): Promise<string> {
  if (stateCache && Date.now() - stateCache.at < 30_000) return stateCache.value;
  const value = await loadLiveState(env);
  stateCache = { at: Date.now(), value };
  return value;
}

export function parseAction(raw: string): HarnessAction | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<HarnessAction>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!['tool', 'final', 'ask', 'plan'].includes(String(parsed.type))) return null;
    if (typeof parsed.say !== 'string') return null;
    const args = (parsed.args && typeof parsed.args === 'object' ? parsed.args : {}) as HarnessAction['args'];
    return {
      type: parsed.type as HarnessAction['type'],
      say: parsed.say,
      tool: typeof parsed.tool === 'string' ? parsed.tool : null,
      args: {
        service: typeof args.service === 'string' ? args.service : null,
        window: typeof args.window === 'string' ? args.window : null,
        limit: typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : null,
        job: typeof args.job === 'string' ? args.job : null,
        title: typeof args.title === 'string' ? args.title : null,
        steps: typeof args.steps === 'string' ? args.steps : null,
        budget_usd:
          typeof args.budget_usd === 'number' && Number.isFinite(args.budget_usd) ? args.budget_usd : null,
      },
      plan:
        parsed.plan && typeof parsed.plan === 'object' && typeof parsed.plan.title === 'string'
          ? {
              title: parsed.plan.title,
              steps: Array.isArray(parsed.plan.steps)
                ? parsed.plan.steps.filter((s): s is string => typeof s === 'string').slice(0, 12)
                : [],
            }
          : null,
    };
  } catch {
    return null;
  }
}

/** Local Qwen → LiteLLM gateway → the deployed edge. All explicit. */
async function complete(
  messages: LlmMessage[],
  env: NodeJS.ProcessEnv,
): Promise<Completion> {
  // Local first, but never for longer than a reply can wait: a dead llama-server
  // must not hold the turn for 45 seconds before the edge is tried.
  const local = await runLlm(
    messages,
    {
      tier: 'local',
      jsonSchema: { name: 'harness_action', schema: ACTION_SCHEMA as unknown as Record<string, unknown> },
      localMaxTokens: 900,
      timeoutMs: 20_000,
    },
    env,
  );
  if (local.ok && local.text) {
    return { ok: true, text: local.text, tier: 'local' };
  }

  const edge = (env.OPENHUB_HARNESS_EDGE_URL || 'https://mobile-gateway.tap4500.workers.dev/v1/chat/completions').trim();
  try {
    const response = await fetch(edge, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-app': 'openhub',
        'x-llm-task': 'general',
      },
      body: JSON.stringify({
        messages,
        max_tokens: 900,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (response.ok && content) return { ok: true, text: content, tier: 'edge' };
    return {
      ok: false,
      error: body?.error?.message || `edge returned HTTP ${response.status}`,
    };
  } catch (error) {
    const gateway = await runLlm(
      messages,
      {
        tier: 'gateway',
        jsonSchema: { name: 'harness_action', schema: ACTION_SCHEMA as unknown as Record<string, unknown> },
        timeoutMs: 20_000,
      },
      env,
    );
    if (gateway.ok && gateway.text) return { ok: true, text: gateway.text, tier: 'gateway' };
    return {
      ok: false,
      error: `local: ${local.error ?? 'unavailable'}; edge: ${
        error instanceof Error ? error.message : String(error)
      }; gateway: ${gateway.error ?? 'unavailable'}`,
    };
  }
}

export interface TurnResult {
  ok: boolean;
  text: string;
  tier: string;
  toolCalls: Array<{ tool: string; ok: boolean; summary: string; at: string }>;
  /** Present when the model asked for a write; the turn paused for approval. */
  approval?: ApprovalRecord;
  error?: string;
}

export async function runTurn(
  sessionId: string,
  userText: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TurnResult> {
  const clean = userText.trim().slice(0, 4000);
  if (!clean) return { ok: false, text: 'Empty message.', tier: 'none', toolCalls: [], error: 'empty' };

  const history = listMessages(sessionId, 8);
  addMessage(sessionId, 'user', clean);
  publish(sessionId, 'turn.started', { at: new Date().toISOString() });

  const system = buildSystemPrompt(await liveState(env));
  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content }) as LlmMessage),
    { role: 'user', content: clean },
  ];

  const calls: TurnResult['toolCalls'] = [];
  let lastTier = 'none';
  let repaired = false;

  for (let step = 0; step <= MAX_TOOL_STEPS; step += 1) {
    const result = await complete(messages, env);
    lastTier = result.tier ?? lastTier;
    if (!result.ok || !result.text) {
      const text = `I could not reach a model lane. ${result.error ?? ''}`.trim();
      addMessage(sessionId, 'assistant', text);
      publish(sessionId, 'error', { message: text });
      return { ok: false, text, tier: lastTier, toolCalls: calls, error: result.error };
    }

    const action = parseAction(result.text);
    if (!action) {
      if (repaired) {
        const text = 'The model returned a reply that is not the harness JSON envelope. I stopped rather than guess.';
        addMessage(sessionId, 'assistant', text);
        publish(sessionId, 'error', { message: text });
        return { ok: false, text, tier: lastTier, toolCalls: calls, error: 'invalid_envelope' };
      }
      repaired = true;
      messages.push({ role: 'assistant', content: result.text });
      messages.push({
        role: 'user',
        content:
          'Your previous reply was not valid JSON in the required envelope. Reply with exactly one JSON object: ' +
          '{"type":"tool"|"final"|"ask"|"plan","say":"...","tool":null,"args":{"service":null,"window":null,"limit":null,"job":null,"title":null,"steps":null,"budget_usd":null},"plan":null}',
      });
      continue;
    }

    if (action.type === 'final' || action.type === 'ask' || action.type === 'plan') {
      addMessage(sessionId, 'assistant', action.say);
      publish(sessionId, 'assistant.final', {
        text: action.say,
        tier: lastTier,
        plan: action.plan,
        at: new Date().toISOString(),
      });
      return { ok: true, text: action.say, tier: lastTier, toolCalls: calls };
    }

    const tool = action.tool ?? '';
    if (!toolByName(tool)) {
      const observation = `Unknown tool "${tool}". Available: ${TOOLS.map((t) => t.name).join(', ')}.`;
      messages.push({ role: 'assistant', content: result.text });
      messages.push({ role: 'user', content: `TOOL RESULT ${JSON.stringify({ tool, ok: false, summary: observation })}` });
      continue;
    }

    if (requiresApproval(tool)) {
      const approval = createApproval(sessionId, tool, action.args as unknown as Record<string, unknown>);
      const say = action.say.trim() || `I need your approval to ${tool}.`;
      addMessage(sessionId, 'assistant', say);
      publish(sessionId, 'approval.required', { approval });
      return { ok: true, text: say, tier: lastTier, toolCalls: calls, approval };
    }

    const startedAt = Date.now();
    publish(sessionId, 'tool.started', { tool, args: action.args, at: new Date(startedAt).toISOString() });
    const toolResult: ToolResult = await executeTool(tool, action.args, env);
    const finishedAt = Date.now();
    addToolCall(
      sessionId,
      tool,
      action.args as unknown as Record<string, unknown>,
      toolResult as unknown as Record<string, unknown>,
      toolResult.ok ? 'ok' : 'error',
      startedAt,
      finishedAt,
    );
    calls.push({ tool, ok: toolResult.ok, summary: toolResult.summary, at: toolResult.at });
    publish(sessionId, 'tool.result', {
      tool,
      ok: toolResult.ok,
      summary: toolResult.summary,
      at: toolResult.at,
    });

    messages.push({ role: 'assistant', content: result.text });
    messages.push({
      role: 'user',
      content: `TOOL RESULT ${JSON.stringify({
        tool,
        ok: toolResult.ok,
        summary: toolResult.summary,
        at: toolResult.at,
        data: toolResult.ok ? toolResult.data : undefined,
      })}`,
    });
  }

  const text = `I stopped after ${MAX_TOOL_STEPS} tool calls without a final answer. The last evidence is above.`;
  addMessage(sessionId, 'assistant', text);
  publish(sessionId, 'assistant.final', { text, tier: lastTier, at: new Date().toISOString() });
  return { ok: false, text, tier: lastTier, toolCalls: calls, error: 'step_limit' };
}
