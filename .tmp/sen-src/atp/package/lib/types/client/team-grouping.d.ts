/**
 * How the Settings Team list is organized: the fixed official series, the
 * reader's own categories, and the filter one chip or menu entry selects.
 *
 * A Team appears exactly once in the grouped list. The reader's own placement
 * wins over the shipped series, because moving a built-in Team into a category
 * is an explicit act and showing it in two places would make the list lie about
 * how many Teams it holds; the series stays available as a filter and as a tag
 * on the row, so the official fact is never lost. A Team the reader never
 * placed stays under its series when it ships with the plugin, and under
 * "uncategorized" when it does not.
 *
 * This module is pure: the views own their own filter text and collapse state,
 * and the controller owns the stored categories, so grouping can be tested
 * without a DOM.
 * @module dsh-agent-team-presets/client/team-grouping
 */
import type { TeamFilter } from '../team-search.ts';
import type { TeamCategory, TeamCategoryAssignment, TeamPreset, TeamSeries } from '../types.ts';
/** Which origin bucket the source chips select. */
export type SourceSelection = 'all' | 'builtin' | 'custom';
/**
 * One value the category chips and the category menu select.
 *
 * The shipped series and the reader's categories are different facts that share
 * one control, so their values are namespaced: a category id can never collide
 * with a series value, and an unknown id simply selects nothing.
 */
export type CategorySelection = 'all' | 'uncategorized' | `series:${TeamSeries}` | `category:${string}`;
/** The list's own filter, before it is resolved into the shared search model. */
export interface TeamListFilter {
    /** Free text the search box holds. */
    readonly query: string;
    /** Which origin the reader selected. */
    readonly source: SourceSelection;
    /** Which series, category, or "uncategorized" the reader selected. */
    readonly category: CategorySelection;
}
/** One rendered group of the Team list. */
export interface TeamListGroup {
    /** What kind of group this is; the header copy is chosen from it. */
    readonly kind: 'series' | 'category' | 'uncategorized';
    /** Stable identity for the header's collapse state. */
    readonly id: string;
    /** The official series, when this is a series group. */
    readonly series?: TeamSeries;
    /** The user category identity, when this is a category group. */
    readonly categoryId?: string;
    /** The Teams in this group, in configuration order. */
    readonly teams: readonly TeamPreset[];
}
/** The selection the page starts from: everything, no filter. */
export declare const ALL_TEAMS_FILTER: TeamListFilter;
/**
 * The value the category menu uses for one user category.
 * @param categoryId - the category identity.
 * @returns the selection value.
 */
export declare function categorySelectionOf(categoryId: string): CategorySelection;
/**
 * The value the category menu uses for one official series.
 * @param series - the series identity.
 * @returns the selection value.
 */
export declare function seriesSelectionOf(series: TeamSeries): CategorySelection;
/**
 * Resolve the list's selection into the shared search filter.
 *
 * One control carries two different facts, so exactly one of `series` and
 * `category` is ever constrained: selecting 研发规模 asks the official-series
 * question, and selecting a personal category asks the membership question.
 * @param filter - the list's own filter.
 * @returns the filter the shared search model applies.
 */
export declare function searchFilterOf(filter: TeamListFilter): TeamFilter;
/**
 * Whether the list is showing one group rather than the whole grouped list.
 * @param filter - the list's own filter.
 * @returns whether a series, a category, or "uncategorized" is selected.
 */
export declare function isSingleGroup(filter: TeamListFilter): boolean;
/**
 * Group the Teams the page shows by series, category, then "uncategorized".
 *
 * Empty groups are dropped: a header with nothing under it is noise, and the
 * filter control still reaches every category and both series. The order is
 * the shipped series order first, then the reader's category order, with the
 * unplaced remainder last, so the list never reshuffles as Teams move.
 * @param teams - the Teams to group, in configuration order.
 * @param categories - the reader's categories, in stored order.
 * @param assignments - the live memberships.
 * @returns the non-empty groups, in render order.
 */
export declare function groupTeams(teams: readonly TeamPreset[], categories: readonly TeamCategory[], assignments: readonly TeamCategoryAssignment[]): TeamListGroup[];
/**
 * Move one category one position up or down.
 *
 * The whole order is renumbered from zero, so a document that once held gaps or
 * duplicate orders is repaired by the same write that moves one category, and
 * two readers' order values cannot drift apart over repeated moves.
 * @param categories - the current categories.
 * @param categoryId - the category to move.
 * @param direction - toward the top (`up`) or the bottom (`down`).
 * @returns the next category list, ordered and renumbered; the same list when
 * the move is not possible.
 */
export declare function moveCategory(categories: readonly TeamCategory[], categoryId: string, direction: 'up' | 'down'): TeamCategory[];
/** Longest category name the dialog accepts, in characters. */
export declare const CATEGORY_NAME_LIMIT = 40;
/**
 * Cap a category name to what the dialog accepts.
 * @param name - the raw input.
 * @returns the trimmed name, cut to the limit.
 */
export declare function categoryNameOf(name: string): string;
/**
 * Whether one Team passes the second-level filter the picker shows.
 *
 * A user category and a shipped series share one control, exactly as on the
 * settings list: selecting a category asks membership, selecting a series asks
 * an official fact, and selecting neither accepts every Team.
 * @param team - the Team to judge.
 * @param series - the selected official series, or `all`.
 * @param categoryId - the selected user category, or the empty string.
 * @param assignments - the live `teamId → categoryId` memberships.
 * @returns whether the Team belongs to the active selection.
 */
export declare function matchesCategoryFilter(team: TeamPreset, series: TeamSeries | 'all', categoryId: string, assignments: readonly TeamCategoryAssignment[]): boolean;
/**
 * The Team-level value one picker filter row starts from.
 */
export declare const PICKER_CATEGORY_ALL: {
    series: "all";
    categoryId: string;
};
