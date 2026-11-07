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
import { builtinEntry } from "./team-catalog.js";
/**
 * Resolve one Team's origin from the stable official catalog.
 *
 * Identity, not a user-editable field, is the evidence: an imported document
 * that reuses a builtin id is treated as that builtin Team, while a copied Team
 * gets a fresh id and is therefore custom.
 * @param teamId - stable Team identity.
 * @returns the origin facts.
 */
export function teamOrigin(teamId) {
    const entry = builtinEntry(teamId);
    return entry === undefined ? { source: 'custom' } : { source: 'builtin', series: entry.series };
}
/** Weight per searchable field, highest first. */
const FIELD_WEIGHTS = {
    name: 100,
    tags: 40,
    summary: 30,
    useCases: 20,
    quickPrompts: 15,
    notes: 10,
};
/**
 * Split a query into lowercase tokens.
 *
 * Whitespace separates tokens; each token is a literal substring match, so a
 * Chinese phrase without spaces still matches, and a multi-word query requires
 * every token to appear somewhere in the indexed fields.
 * @param query - raw user input.
 * @returns lowercase tokens in input order.
 */
export function queryTokens(query) {
    return query.trim().toLowerCase().split(/\s+/u).filter(token => token !== '');
}
/**
 * Index one Team's searchable text.
 * @param team - the Team preset.
 * @returns every indexed field, lowercase, in a fixed order.
 */
function indexedFields(team) {
    const metadata = team.metadata;
    return {
        name: team.name.toLowerCase(),
        tags: (metadata?.tags ?? []).join(' ').toLowerCase(),
        summary: (metadata?.summary ?? '').toLowerCase(),
        useCases: (metadata?.useCases ?? []).join(' ').toLowerCase(),
        quickPrompts: (metadata?.quickPrompts ?? []).join(' ').toLowerCase(),
        notes: (metadata?.notes ?? '').toLowerCase(),
    };
}
/**
 * Match one Team against the query tokens.
 * @param team - the Team preset.
 * @param tokens - lowercase query tokens.
 * @returns the score and matched fields, or undefined when a token is missing.
 */
export function matchTeam(team, tokens) {
    if (tokens.length === 0)
        return { score: 0, fields: [] };
    const fields = indexedFields(team);
    const matched = new Set();
    let score = 0;
    for (const token of tokens) {
        let hit = false;
        for (const field of Object.keys(FIELD_WEIGHTS)) {
            if (!fields[field].includes(token))
                continue;
            hit = true;
            matched.add(field);
            score += FIELD_WEIGHTS[field];
        }
        if (!hit)
            return undefined;
    }
    return { score, fields: Object.keys(FIELD_WEIGHTS).filter(field => matched.has(field)) };
}
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
export function searchTeams(teams, filter = {}, assignments = []) {
    const tokens = queryTokens(filter.query ?? '');
    const assigned = new Map(assignments.map(row => [row.teamId, row.categoryId]));
    const hits = [];
    for (const team of teams) {
        const origin = teamOrigin(team.id);
        if (filter.source !== undefined && filter.source !== 'all' && filter.source !== origin.source)
            continue;
        if (filter.series !== undefined && filter.series !== 'all' && filter.series !== origin.series)
            continue;
        if (filter.category !== undefined && filter.category !== 'all') {
            const category = assigned.get(team.id);
            if (filter.category === 'uncategorized') {
                if (category !== undefined)
                    continue;
            }
            else if (category !== filter.category)
                continue;
        }
        const match = matchTeam(team, tokens);
        if (match === undefined)
            continue;
        hits.push({ teamId: team.id, score: match.score, fields: match.fields });
    }
    if (tokens.length === 0)
        return hits;
    return hits
        .map((hit, index) => ({ hit, index }))
        .sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
        .map(({ hit }) => hit);
}
/**
 * Group Teams by official series for the two fixed series views.
 * @param teams - every configured Team, in display order.
 * @returns the Teams of each series, in catalog order.
 */
export function teamsBySeries(teams) {
    const groups = [
        { series: 'classic-development', teams: [] },
        { series: 'work-modes', teams: [] },
    ];
    for (const team of teams) {
        const origin = teamOrigin(team.id);
        const group = groups.find(row => row.series === origin.series);
        group?.teams.push(team);
    }
    return groups;
}
/**
 * List the Teams inside one user category.
 * @param teams - every configured Team.
 * @param assignments - local memberships.
 * @param categoryId - the category identity.
 * @returns the member Teams, in configuration order.
 */
export function teamsInCategory(teams, assignments, categoryId) {
    const ids = new Set(assignments.filter(row => row.categoryId === categoryId).map(row => row.teamId));
    return teams.filter(team => ids.has(team.id));
}
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
export function withTeamCategory(assignments, teamId, categoryId) {
    const rest = assignments.filter(row => row.teamId !== teamId);
    return categoryId === undefined ? rest : [...rest, { teamId, categoryId }];
}
/**
 * Delete one category without touching any Team.
 * @param categories - current categories.
 * @param assignments - current memberships.
 * @param categoryId - category to delete.
 * @returns the remaining categories and memberships.
 */
export function withoutCategory(categories, assignments, categoryId) {
    return {
        categories: categories.filter(row => row.id !== categoryId),
        assignments: assignments.filter(row => row.categoryId !== categoryId),
    };
}
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
export function reconciledAssignments(categories, teams, assignments) {
    const categoryIds = new Set(categories.map(row => row.id));
    const teamIds = new Set(teams.map(team => team.id));
    return assignments.filter(row => categoryIds.has(row.categoryId)
        && (teamIds.has(row.teamId) || builtinEntry(row.teamId) !== undefined));
}
/**
 * Drop memberships that point at a category or Team that no longer exists.
 * @param categories - current categories.
 * @param teams - current Teams.
 * @param assignments - current memberships.
 * @returns the memberships that still resolve on both sides.
 */
export function liveAssignments(categories, teams, assignments) {
    const categoryIds = new Set(categories.map(row => row.id));
    const teamIds = new Set(teams.map(team => team.id));
    return assignments.filter(row => categoryIds.has(row.categoryId) && teamIds.has(row.teamId));
}
/**
 * Derive a category identity that no existing category uses.
 * @param categories - current categories.
 * @returns a stable unique id.
 */
export function newCategoryId(categories) {
    const used = new Set(categories.map(row => row.id));
    for (;;) {
        const id = `category-${crypto.randomUUID()}`;
        if (!used.has(id))
            return id;
    }
}
/**
 * Order categories for display and for the next order value.
 * @param categories - current categories.
 * @returns the categories sorted by `order`, then identity.
 */
export function orderedCategories(categories) {
    return [...categories].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
/**
 * Append one category at the end of the order.
 * @param categories - current categories.
 * @param name - display name.
 * @returns the next category list.
 */
export function withNewCategory(categories, name) {
    const order = categories.reduce((max, row) => Math.max(max, row.order), -1) + 1;
    return [...categories, { id: newCategoryId(categories), name: name.trim(), order }];
}
