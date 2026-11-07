/**
 * Model-facing Team Skill tools for the Session root.
 *
 * The page and the captain reach the same manager, so an assignment made here
 * obeys exactly the rules the page shows: a skill is bound to one role slot, a
 * delete is refused while anything still holds it, and a shipped skill is
 * read-only. Tools are registered on the root Agent only — a teammate must not
 * be able to grant itself skills, which is the whole point of the isolation.
 * @module dsh-agent-team-presets/team-skills/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TeamSkillManager } from './manager.ts';
import type { TeamSkillStore } from './store.ts';
/** What the tools need from the plugin. */
export interface TeamSkillToolDeps {
    /** Wait for startup and return its failure reason instead of a misleading empty library. */
    readonly ready?: () => Promise<string | undefined>;
    /** The asset store. */
    readonly store: TeamSkillStore;
    /** The binding table and its guards. */
    readonly manager: TeamSkillManager;
    /** Reads the Teams the page shows. */
    readonly teams: () => readonly {
        id: string;
        name: string;
        captain: {
            name: string;
        };
        members: readonly {
            id?: string;
            name: string;
        }[];
    }[];
    /** Re-applies live Agents after a binding changed. */
    readonly resync: () => void;
}
/**
 * Register the Team Skill tools on one root Agent.
 * @param ctx - the plugin context, for its logger.
 * @param agent - the Session root the tools belong to.
 * @param deps - the store, the manager, and the live roster.
 * @returns the disposer withdrawing the management tools.
 */
export declare function registerTeamSkillTools(ctx: Context, agent: Agent, deps: TeamSkillToolDeps): () => void;
