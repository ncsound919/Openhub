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
import { TEAM_SERIES } from "../team-catalog.js";
import { orderedCategories, teamOrigin } from "../team-search.js";
/** The selection the page starts from: everything, no filter. */
export const ALL_TEAMS_FILTER = { query: '', source: 'all', category: 'all' };
/**
 * The value the category menu uses for one user category.
 * @param categoryId - the category identity.
 * @returns the selection value.
 */
export function categorySelectionOf(categoryId) {
    return `category:${categoryId}`;
}
/**
 * The value the category menu uses for one official series.
 * @param series - the series identity.
 * @returns the selection value.
 */
export function seriesSelectionOf(series) {
    return `series:${series}`;
}
/**
 * Resolve the list's selection into the shared search filter.
 *
 * One control carries two different facts, so exactly one of `series` and
 * `category` is ever constrained: selecting 研发规模 asks the official-series
 * question, and selecting a personal category asks the membership question.
 * @param filter - the list's own filter.
 * @returns the filter the shared search model applies.
 */
export function searchFilterOf(filter) {
    const { category } = filter;
    const series = category.startsWith('series:') ? category.slice('series:'.length) : 'all';
    const membership = category.startsWith('category:')
        ? category.slice('category:'.length)
        : category === 'uncategorized' ? 'uncategorized' : 'all';
    return { query: filter.query, source: filter.source, series, category: membership };
}
/**
 * Whether the list is showing one group rather than the whole grouped list.
 * @param filter - the list's own filter.
 * @returns whether a series, a category, or "uncategorized" is selected.
 */
export function isSingleGroup(filter) {
    return filter.category !== 'all';
}
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
export function groupTeams(teams, categories, assignments) {
    const placed = new Map(assignments.map(row => [row.teamId, row.categoryId]));
    const ordered = orderedCategories(categories);
    const known = new Set(ordered.map(row => row.id));
    const groups = [
        ...TEAM_SERIES.map(row => ({
            group: { kind: 'series', id: `series:${row.id}`, series: row.id, teams: [] },
            teams: [],
        })),
        ...ordered.map(row => ({
            group: { kind: 'category', id: `category:${row.id}`, categoryId: row.id, teams: [] },
            teams: [],
        })),
        { group: { kind: 'uncategorized', id: 'uncategorized', teams: [] }, teams: [] },
    ];
    const unplaced = groups[groups.length - 1];
    for (const team of teams) {
        const categoryId = placed.get(team.id);
        const own = categoryId === undefined || !known.has(categoryId)
            ? undefined
            : groups.find(row => row.group.categoryId === categoryId);
        const origin = teamOrigin(team.id);
        const bucket = own
            ?? (origin.series === undefined ? undefined : groups.find(row => row.group.series === origin.series))
            ?? unplaced;
        bucket?.teams.push(team);
    }
    return groups
        .filter(row => row.teams.length > 0)
        .map(row => ({ ...row.group, teams: row.teams }));
}
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
export function moveCategory(categories, categoryId, direction) {
    const ordered = orderedCategories(categories);
    const at = ordered.findIndex(row => row.id === categoryId);
    const target = direction === 'up' ? at - 1 : at + 1;
    if (at < 0 || target < 0 || target >= ordered.length)
        return [...categories];
    const next = [...ordered];
    const moved = next[at];
    next[at] = next[target];
    next[target] = moved;
    return next.map((row, index) => row.order === index ? row : { ...row, order: index });
}
/** Longest category name the dialog accepts, in characters. */
export const CATEGORY_NAME_LIMIT = 40;
/**
 * Cap a category name to what the dialog accepts.
 * @param name - the raw input.
 * @returns the trimmed name, cut to the limit.
 */
export function categoryNameOf(name) {
    return name.trim().slice(0, CATEGORY_NAME_LIMIT);
}
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
export function matchesCategoryFilter(team, series, categoryId, assignments) {
    // The settings list ANDs both dimensions; its controls clear the one that no
    // longer applies, so a caller that sets both asks for their intersection.
    const matchesSeries = series === 'all' || teamOrigin(team.id).series === series;
    const matchesCategory = categoryId === '' || assignments.some(row => row.teamId === team.id && row.categoryId === categoryId);
    return matchesSeries && matchesCategory;
}
/**
 * The Team-level value one picker filter row starts from.
 */
export const PICKER_CATEGORY_ALL = { series: 'all', categoryId: '' };
