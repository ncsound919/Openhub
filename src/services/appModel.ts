/**
 * App model wiring (generated alongside modelAssignment.ts).
 *
 * OpenHub already has a local-first router (`llmRouter.ts`). This wrapper binds
 * it to the app's registry entry so callers do not hardcode a model id.
 */
import { runLlm, type LlmMessage, type LlmResult, type RunLlmOptions } from './llmRouter';
import { MODEL_ASSIGNMENT } from './modelAssignment';

export const APP_MODEL = MODEL_ASSIGNMENT;

export function runAppLlm(messages: LlmMessage[], opts: RunLlmOptions = {}): Promise<LlmResult> {
  return runLlm(messages, {
    ...opts,
    // The local tier picks its own model from OPENHUB_LOCAL_LLM_MODEL. Do not
    // leak the phone's model id (`qwen3.5-4b`) into a cloud request: a gateway
    // may interpret an unknown id as a pin, and Sieve would attribute every
    // cloud call to a model that never ran. `opts.model` is only present when
    // the caller made an explicit choice.
    tier: opts.tier ?? 'auto',
  });
}
