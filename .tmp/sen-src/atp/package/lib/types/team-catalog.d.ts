/**
 * The single official catalog of Teams this plugin ships.
 *
 * v0.1.6 ships nine presets in two fixed series: the three original
 * research-and-development Teams and the six work-mode Teams contributed in
 * PR #1. The catalog is the authority for a fresh install, for migration, for
 * "restore defaults", and for the read-only source/series facts the Settings
 * page filters on. It is deliberately separate from the stored Team records:
 * a stored Team is the user's copy and may drift, while this catalog never
 * changes except when a plugin release changes it.
 *
 * Each entry carries its display metadata. Metadata is presentation-only and
 * is never read by the runtime composition path (see `src/types.ts`).
 * @module dsh-agent-team-presets/team-catalog
 */
import type { TeamDisplayMetadata, TeamSeries } from './types.ts';
import type { TeamPresetTransfer } from './preset-transfer.ts';
/** One official Team: stable identity, fixed series, shipped document, display metadata. */
export interface BuiltinTeamCatalogEntry {
    /** Stable identity every stored copy keeps across upgrades. */
    readonly id: string;
    /** Fixed official series this Team belongs to. */
    readonly series: TeamSeries;
    /** Shareable document the Team is installed and restored from. */
    readonly document: TeamPresetTransfer;
    /** Presentation-only discovery metadata. */
    readonly metadata: TeamDisplayMetadata;
    /**
     * Official default Team Skill assignments, expressed by stable skill id and
     * role name so a document can be resolved on another deployment.
     */
    readonly officialSkillBindings: readonly OfficialSkillBinding[];
}
/** One official default binding of a shipped skill to a role slot. */
export interface OfficialSkillBinding {
    /** Shipped skill id, matching the package's `assets/skills/<id>` folder. */
    readonly skillId: string;
    /** Role name inside the shipped document. */
    readonly roleName: string;
}
/**
 * The shipped delivery skills, assigned by default only to the
 * `repository-specialist` role of the Teams that own repository delivery work.
 *
 * A user may add or remove assignments locally; those local changes are not
 * part of the preset document. This declaration is.
 */
export declare const OFFICIAL_REPOSITORY_SKILLS: readonly OfficialSkillBinding[];
/**
 * The shipped delivery skills, assigned by default to the `executor` role
 * of software engineering Teams.
 */
export declare const OFFICIAL_EXECUTOR_SKILLS: readonly OfficialSkillBinding[];
/**
 * The method skills assigned by default to the 需求探索 team: grilling to the
 * captain, and research to the two scouting roles that gather evidence for it.
 */
export declare const OFFICIAL_DISCOVERY_SKILLS: readonly OfficialSkillBinding[];
/** The method skill assigned by default to the 科研协作 team's evidence scout. */
export declare const OFFICIAL_RESEARCH_SKILLS: readonly OfficialSkillBinding[];
/** Series display order and stable identity. */
export declare const TEAM_SERIES: readonly {
    readonly id: TeamSeries;
    readonly order: number;
}[];
/** Every official Team, in install order: the three development Teams, then the six work modes. */
export declare const BUILTIN_TEAM_CATALOG: readonly BuiltinTeamCatalogEntry[];
/** Every official Team identity, in install order. */
export declare const BUILTIN_TEAM_IDS: readonly string[];
/**
 * Look up one official Team by identity.
 * @param id - Team identity.
 * @returns the catalog entry, or undefined for a custom Team.
 */
export declare function builtinEntry(id: string): BuiltinTeamCatalogEntry | undefined;
/**
 * Resolve the official series of one Team identity.
 * @param id - Team identity.
 * @returns its fixed series, or undefined for a custom Team.
 */
export declare function teamSeriesOf(id: string): TeamSeries | undefined;
