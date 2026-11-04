/**
 * Contenders:
 *   - hf-jev         -> OpenHub's real `decideSystemOne` against the Hugging
 *                       Face Jev-Style 0.8B model served by `jev-style serve`
 *   - deepseek-flash -> DeepSeek V4.1 Flash over the same typed questions
 *   - deepseek-v4-pro-> judge, used only on disagreements (optional)
 *
 * Both contenders receive exactly the same state + questions built by
 * OpenHub's own advisories. No contender sees the ground-truth label.
 */

import { decideSystemOne } from '../../src/services/jevClient.js';
import type { AnswerMap, BenchmarkCase, EngineRun, ExpectedValue, NormalizedAnswer } from './types.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

export const PRICES: Record<string, { input: number; output: number }> = {
  // USD per 1M tokens. Rates from openhub/src/services/costTracker.ts.
  'deepseek-flash': { input: 0.1, output: 0.5 },
  'deepseek-v4-pro': { input: 2, output: 8 },
};

function apiKey(): string {
  const key = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set (expected in openhub/.env)');
  return key;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function asNoul(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 0.5;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
    const n = Number(s);
    if (Number.isFinite(n)) return n >= 0.5;
  }
  return undefined;
}

export function normalizeAnswers(raw: unknown, c: BenchmarkCase): AnswerMap {
  const out: AnswerMap = {};
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nested = root.answers;
  // Some models wrap the answer map in `{answers:{…}}`; others drop the wrapper.
  const box = (nested && typeof nested === 'object' && Object.keys(nested as object).length > 0 ? nested : root) as Record<string, unknown>;
  for (const [key, question] of Object.entries(c.questions)) {
    const a = (box[key] ?? {}) as Record<string, unknown>;
    if (question.type === 'choice') {
      const value = typeof a.choice === 'string' ? a.choice : typeof a.value === 'string' ? a.value : undefined;
      if (value !== undefined) {
        const criteria = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
        const match = criteria.find((k) => k.toLowerCase() === value.trim().toLowerCase());
        out[key] = { type: 'choice', value: match ?? value.trim(), confidence: typeof a.confidence === 'number' ? a.confidence : undefined };
      }
    } else if (question.type === 'noul') {
      const value = asNoul(a.noul ?? a.value);
      if (value !== undefined) out[key] = { type: 'noul', value };
    } else {
      const rawScore = a.score ?? a.value;
      const n = typeof rawScore === 'number' ? rawScore : Number(rawScore);
      if (Number.isFinite(n)) {
        const max = Array.isArray(question.criteria) ? question.criteria.length - 1 : 3;
        out[key] = { type: 'score', value: Math.max(0, Math.min(max, Math.round(n))) };
      }
    }
  }
  return out;
}

export function isCorrect(expected: ExpectedValue, answer: NormalizedAnswer | undefined): boolean {
  if (!answer) return false;
  if (typeof expected === 'boolean') return answer.value === expected;
  if (typeof expected === 'number') return Number(answer.value) === expected;
  return String(answer.value).toLowerCase() === String(expected).toLowerCase();
}

// ---------------------------------------------------------------------------
// Local JEV
// ---------------------------------------------------------------------------

export async function runLocalJev(c: BenchmarkCase): Promise<EngineRun> {
  const started = Date.now();
  const result = await decideSystemOne({ state: c.state, questions: c.questions });
  if (!result.ok || !result.answers) {
    return {
      engine: 'hf-jev',
      ok: false,
      answers: {},
      latencyMs: result.latencyMs || Date.now() - started,
      error: result.error ?? 'no answers',
      model: result.model,
    };
  }
  const answers: AnswerMap = {};
  for (const [key, a] of Object.entries(result.answers)) {
    // Jev-Style returns a continuous score (expected value); the benchmark
    // compares the discrete 0-3 rung, so round like the UI does.
    answers[key] = {
      type: a.type,
      value: a.type === 'noul' ? a.noul >= 0.5 : a.type === 'score' ? Math.round(a.score) : a.choice,
      confidence: (a as any).confidence,
    };
  }
  return {
    engine: 'hf-jev',
    ok: true,
    answers,
    latencyMs: result.latencyMs,
    model: result.model,
    usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : undefined,
  };
}

// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are OpenHub's System One coding-decision engine.
You receive a JSON STATE and typed QUESTIONS. Answer every question exactly.

Answer formats:
- "choice": pick one criteria key verbatim -> {"type":"choice","choice":"<key>"}
- "noul" (boolean confidence): a number from 0 to 1 -> {"type":"noul","noul":0.87}
- "score": zero-based integer index into the criteria array -> {"type":"score","score":2}

Reply with JSON only, no prose: {"answers":{"<question key>":{...}}}`;

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function postDeepSeek(body: Record<string, unknown>, timeoutMs = 120_000): Promise<{ data: any; latencyMs: number }> {
  const key = apiKey();
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    const started = Date.now();
    try {
      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
        break;
      }
      return { data: await res.json(), latencyMs: Date.now() - started };
    } catch (err: any) {
      lastError = err?.message ?? 'request failed';
    }
  }
  throw new Error(lastError || 'DeepSeek request failed');
}

export async function runDeepSeek(c: BenchmarkCase, model = 'deepseek-flash'): Promise<EngineRun> {
  const payload = {
    state: c.state,
    questions: c.questions,
  };
  const started = Date.now();
  try {
    const { data, latencyMs } = await postDeepSeek({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1600,
      effort: 'low',
      stream: false,
    });
    const text = data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(text);
    const answers = parsed ? normalizeAnswers(parsed, c) : {};
    return {
      engine: model,
      ok: Object.keys(answers).length > 0,
      answers,
      latencyMs,
      model: data?.model ?? model,
      raw: text.slice(0, 4000),
      usage: {
        inputTokens: Number(data?.usage?.prompt_tokens) || 0,
        outputTokens: Number(data?.usage?.completion_tokens) || 0,
        reasoningTokens: Number(data?.usage?.completion_tokens_details?.reasoning_tokens) || 0,
      },
      error: Object.keys(answers).length > 0 ? undefined : 'no parseable answers',
    };
  } catch (err: any) {
    return { engine: model, ok: false, answers: {}, latencyMs: Date.now() - started, error: err?.message ?? 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Judge (DeepSeek Pro, disagreements only)
// ---------------------------------------------------------------------------

export interface JudgeVerdict {
  winner: 'jev' | 'deepseek' | 'tie';
  reason: string;
  answers: AnswerMap;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

const JUDGE_PROMPT = `You are an impartial senior code reviewer.
Two engines answered the same typed decision questions about a real software change.
Engine A and Engine B each returned JSON answers. Judge which answer is more defensible.
Do not assume either is correct. Return JSON only:
{"winner":"A"|"B"|"tie","reason":"<= 2 sentences","answers":{"<question key>":{...}}}
where "answers" is your own answer in the same typed format.`;

export async function judgeCase(
  c: BenchmarkCase,
  jev: EngineRun,
  deepseek: EngineRun,
  model = 'deepseek-v4-pro',
): Promise<JudgeVerdict | null> {
  try {
    const { data } = await postDeepSeek({
      model,
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            state: c.state,
            questions: c.questions,
            engineA: jev.answers,
            engineB: deepseek.answers,
          }),
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 900,
      effort: 'low',
      stream: false,
    });
    const parsed = extractJson(data?.choices?.[0]?.message?.content ?? '') as any;
    if (!parsed) return null;
    const winner = String(parsed.winner).toLowerCase();
    return {
      winner: winner === 'a' ? 'jev' : winner === 'b' ? 'deepseek' : 'tie',
      reason: String(parsed.reason ?? '').slice(0, 400),
      answers: normalizeAnswers(parsed, c),
      model: data?.model ?? model,
      usage: {
        inputTokens: Number(data?.usage?.prompt_tokens) || 0,
        outputTokens: Number(data?.usage?.completion_tokens) || 0,
      },
    };
  } catch {
    return null;
  }
}

export function costUsd(model: string, usage?: { inputTokens: number; outputTokens: number }): number {
  if (!usage) return 0;
  const p = PRICES[model];
  if (!p) return 0;
  return (usage.inputTokens / 1_000_000) * p.input + (usage.outputTokens / 1_000_000) * p.output;
}
