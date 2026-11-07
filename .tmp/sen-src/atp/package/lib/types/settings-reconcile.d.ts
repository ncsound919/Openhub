/**
 * Minimal, revision-fenced reconcile of this plugin's own settings document.
 *
 * One startup pass owns every repair the plugin makes to the stored Teams,
 * because they all rewrite the same `teams` array and two writers would race
 * each other's revision fence:
 *
 * - the legacy captain route, which no current schema declares,
 * - a member identity a stored record never carried,
 * - the shipped default presets, installed once per deployment,
 * - a local category membership whose category or custom Team is gone.
 *
 * The pass never touches Session policy, and it writes only when a repair
 * really applies. Read-only and conflict errors are not retried for the same
 * document: the caller notifies again when the document, the Teams value, or the
 * shipped-defaults marker changes.
 * @module dsh-agent-team-presets/settings-reconcile
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
/** Coalesce startup/config edges into one in-flight write and one latest recheck. */
export declare function teamSettingsReconcile(ctx: Context, config: Config, namespace: string): {
    request(): Promise<void>;
    dispose(): void;
};
