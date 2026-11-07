/**
 * Deterministic local Team discovery shared by the Settings page and the
 * composer.
 *
 * Both surfaces ask the same questions — which Teams are shipped, which belong
 * to a series or a user category, and which match these words — so they share
 * one pure model instead of two drifting implementations. The model is
 * deliberately local and explainable: no model call, no vector index, no
 * ranking it cannot show. It indexes only the discovery fields (name, tags,
 * summary, use cases, quick prompts, notes); a Team's system prompt, tool
 * policy, and local paths are never searchable.
 *
 * Display metadata is optional everywhere: a user-created Team with no
 * metadata still matches by name and still appears in every filter.
 * @module dsh-agent-team-presets/team-search
 */
import type { TeamSeries, TeamSource } from './types.ts';
import type { TeamCategory, TeamCategoryAssignment, TeamPreset, TeamSearchHit } from './types.ts';
/** Which origin bucket a filter selects. */
export type TeamSourceFilter = 'all' | TeamSource;
/** Which series a filter selects. */
export type TeamSeriesFilter = 'all' | TeamSeries;
/** Which category a filter selects; `uncategorized` means "no membership". */
export type TeamCategoryFilter = 'all' | 'uncategorized' | (string & {});
/** Every filter both surfaces accept. */
export interface TeamFilter {
    /** Free text; empty matches everything. */
    readonly query?: string;
    /** Origin bucket. */
    readonly source?: TeamSourceFilter;
    /** Official series. */
    readonly series?: TeamSeriesFilter;
    /** User category identity, `uncategorized`, or `all`. */
    readonly category?: TeamCategoryFilter;
}
/** One Team's read-only source facts. */
export interface TeamOrigin {
    /** `builtin` only for a stable official identity. */
    readonly source: TeamSource;
    /** Official series, when the Team is builtin. */
    readonly series?: TeamSeries;
}
/**
 * Resolve one Team's origin from the stable official catalog.
 *
 * Identity, not a user-editable field, is the evidence: an imported document
 * that reuses a builtin id is treated as that builtin Team, while a copied Team
 * gets a fresh id and is therefore custom.
 * @param teamId - stable Team identity.
 * @returns the origin facts.
 */
export declare function teamOrigin(teamId: string): TeamOrigin;
/** Weight per searchable field, highest first. */
declare const FIELD_WEIGHTS: {
    readonly name: 100;
    readonly tags: 40;
    readonly summary: 30;
    readonly useCases: 20;
    readonly quickPrompts: 15;
    readonly notes: 10;
};
/** One matched field of a Team. */
type MatchedField = keyof typeof FIELD_WEIGHTS;
/**
 * Split a query into lowercase tokens.
 *
 * Whitespace separates tokens; each token is a literal substring match, so a
 * Chinese phrase without spaces still matches, and a multi-word query requires
 * every token to appear somewhere in the indexed fields.
 * @param query - raw user input.
 * @returns lowercase tokens in input order.
 */
export declare function queryTokens(query: string): string[];
/**
 * Match one Team against the query tokens.
 * @param team - the Team preset.
 * @param tokens - lowercase query tokens.
 * @returns the score and matched fields, or undefined when a token is missing.
 */
export declare function matchTeam(team: TeamPreset, tokens: readonly string[]): {
    score: number;
    fields: MatchedField[];
} | undefined;
/**
 * Apply every filter and return the matching Teams in a stable order.
 *
 * The order is the configured Team order, with the name score as the only
 * reordering when a query is present; equal scores keep configuration order so
 * the list never jitters between keystrokes.
 * @param teams - every configured Team, in display order.
 * @param filter - the active filters.
 * @param assignments - local `teamId → categoryId` memberships.
 * @returns one hit per matching Team.
 */
export declare function searchTeams(teams: readonly TeamPreset[], filter?: TeamFilter, assignments?: readonly TeamCategoryAssignment[]): TeamSearchHit[];
/**
 * Group Teams by official series for the two fixed series views.
 * @param teams - every configured Team, in display order.
 * @returns the Teams of each series, in catalog order.
 */
export declare function teamsBySeries(teams: readonly TeamPreset[]): {
    series: TeamSeries;
    teams: TeamPreset[];
}[];
/**
 * List the Teams inside one user category.
 * @param teams - every configured Team.
 * @param assignments - local memberships.
 * @param categoryId - the category identity.
 * @returns the member Teams, in configuration order.
 */
export declare function teamsInCategory(teams: readonly TeamPreset[], assignments: readonly TeamCategoryAssignment[], categoryId: string): TeamPreset[];
/**
 * Replace the category of one Team.
 *
 * A Team belongs to at most one category in this release, so assigning replaces
 * the previous membership; `undefined` removes the Team from its category.
 * @param assignments - current memberships.
 * @param teamId - Team identity.
 * @param categoryId - target category, or undefined to unassign.
 * @returns the next membership list.
 */
export declare function withTeamCategory(assignments: readonly TeamCategoryAssignment[], teamId: string, categoryId: string | undefined): TeamCategoryAssignment[];
/**
 * Delete one category without touching any Team.
 * @param categories - current categories.
 * @param assignments - current memberships.
 * @param categoryId - category to delete.
 * @returns the remaining categories and memberships.
 */
export declare function withoutCategory(categories: readonly TeamCategory[], assignments: readonly TeamCategoryAssignment[], categoryId: string): {
    categories: TeamCategory[];
    assignments: TeamCategoryAssignment[];
};
/**
 * Drop the memberships that can never resolve again.
 *
 * Two different losses: a membership whose category was deleted is dead
 * outright, and so is one whose Team was a user-created Team that no longer
 * exists. A membership naming a shipped Team identity is kept even while that
 * Team is absent, because restoring the official preset re-creates the same
 * identity and the user's grouping should survive that round trip.
 * @param categories - current categories.
 * @param teams - current Teams.
 * @param assignments - current memberships.
 * @returns the memberships worth keeping.
 */
export declare function reconciledAssignments(categories: readonly TeamCategory[], teams: readonly TeamPreset[], assignments: readonly TeamCategoryAssignment[]): TeamCategoryAssignment[];
/**
 * Drop memberships that point at a category or Team that no longer exists.
 * @param categories - current categories.
 * @param teams - current Teams.
 * @param assignments - current memberships.
 * @returns the memberships that still resolve on both sides.
 */
export declare function liveAssignments(categories: readonly TeamCategory[], teams: readonly TeamPreset[], assignments: readonly TeamCategoryAssignment[]): TeamCategoryAssignment[];
/**
 * Derive a category identity that no existing category uses.
 * @param categories - current categories.
 * @returns a stable unique id.
 */
export declare function newCategoryId(categories: readonly TeamCategory[]): string;
/**
 * Order categories for display and for the next order value.
 * @param categories - current categories.
 * @returns the categories sorted by `order`, then identity.
 */
export declare function orderedCategories(categories: readonly TeamCategory[]): TeamCategory[];
/**
 * Append one category at the end of the order.
 * @param categories - current categories.
 * @param name - display name.
 * @returns the next category list.
 */
export declare function withNewCategory(categories: readonly TeamCategory[], name: string): TeamCategory[];
export {};
