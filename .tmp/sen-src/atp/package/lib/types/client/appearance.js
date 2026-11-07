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
import { memberTargets } from "../presets.js";
/**
 * Resolve the accent colors of the Team one Session selected.
 * @param teams - every stored Team preset.
 * @param selections - every Session's stored Team selection.
 * @param sessionId - the Lead Session identity.
 * @returns the colors the roster draws with, or undefined when the Session selected no Team.
 */
export function teamAppearance(teams, selections, sessionId) {
    const teamId = selections.find(record => record.sessionId === sessionId)?.teamId;
    const team = teams.find(candidate => candidate.id === teamId);
    if (team === undefined)
        return undefined;
    return {
        captain: team.captain.color,
        members: new Map(memberTargets(team).map(({ member, target }) => [target, member.color])),
    };
}
