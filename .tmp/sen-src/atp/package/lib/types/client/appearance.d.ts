/**
 * Accent colors this plugin publishes to the Agent Teams roster.
 *
 * A Team's configured colors live in the settings document rather than in the
 * Session log, so the browser half resolves them from the same stored Teams and
 * selections the Settings page and the composer control edit.
 *
 * The roster's appearance registry is a deployment extension rather than part of
 * official rc.2, so its shape is declared here instead of imported from a
 * package the plugin cannot depend on. A structurally identical local
 * declaration keeps this plugin compiling against the official release while a
 * deployment that ships the extension still accepts these values.
 * @module dsh-agent-team-presets/appearance
 */
import type { TeamPreset } from '../types.ts';
import type { TeamSelectionRecordView } from './team-presets-controller.ts';
/** Accent colors the Agent Teams roster draws one Team's cards with. */
export interface TeamAppearance {
    /** `#rrggbb` accent of the captain; empty keeps the roster's own color. */
    readonly captain: string;
    /** Accent color per teammate target, keyed by the target the captain summons. */
    readonly members: ReadonlyMap<string, string>;
}
/** The roster extension's registry, as this plugin uses it. */
export interface RosterAppearanceRegistry {
    /**
     * Publish one Team's colors.
     * @param lookup - resolves a Lead Session identity to its colors.
     * @returns the disposer that withdraws this lookup.
     */
    register(lookup: (sessionId: string) => TeamAppearance | undefined): () => void;
}
/**
 * Resolve the accent colors of the Team one Session selected.
 * @param teams - every stored Team preset.
 * @param selections - every Session's stored Team selection.
 * @param sessionId - the Lead Session identity.
 * @returns the colors the roster draws with, or undefined when the Session selected no Team.
 */
export declare function teamAppearance(teams: readonly TeamPreset[], selections: readonly TeamSelectionRecordView[], sessionId: string): TeamAppearance | undefined;
