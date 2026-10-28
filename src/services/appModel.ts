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
    model: opts.model ?? MODEL_ASSIGNMENT.runtimeModel,
    tier: opts.tier ?? 'auto',
  });
}
