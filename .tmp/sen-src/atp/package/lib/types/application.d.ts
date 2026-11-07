/**
 * Apply one Team preset to one live Session.
 *
 * The captain's system prompt shadows the deployment persona for that Session,
 * the captain's independent tool mode scopes the Session's visible global tools,
 * and the Session gains `spawn_team_member`, which applies the selected member's
 * own persona, route, reasoning effort, and tool mode. The Session keeps the
 * model it already selected: a captain never changes the Session's route. A
 * member's persona and tool mode belong to the definition the Team task started
 * with; its route does not, so a corrected route reaches the next member the
 * task summons.
 * @module dsh-agent-team-presets/application
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { TeamPreset } from './types.ts';
import type { MemberRuntime } from './member-runtime.ts';
/** One applied Team preset, owned until the Session's Team changes. */
export interface TeamApplication {
    /** Identity of the applied Team preset. */
    readonly teamId: string;
    /** Fingerprint of the applied definition, so an unchanged one is not re-applied. */
    readonly fingerprint: string;
    /** Disclosure of the tool presentation this Session effectively runs with, when it was overridden. */
    readonly presentationNote?: string;
    /** Release every registration and restore the Session's own composition. */
    dispose(): void;
}
/**
 * Read the latest stored definition of the Team a Session has applied.
 *
 * A running task keeps the definition it started with, but reads the fields it
 * does not freeze — a member's route — from here at spawn time, so a corrected
 * route reaches the next member that task summons.
 */
export type StoredTeam = () => TeamPreset | undefined;
/** Continuable-subagent providers the member tool spawns through. */
export interface MemberProviders {
    /** Provider alias a fresh member is created through. */
    readonly fresh: string;
    /** Provider alias a member forked from the captain's completed turns is created through. */
    readonly fork: string;
    /** Why a fresh member cannot be created in this deployment, when its alias is unusable. */
    readonly freshError?: string | undefined;
    /** Why a forked member cannot be created in this deployment, when its alias is unusable. */
    readonly forkError?: string | undefined;
}
/** Host-side facts one Team application needs beyond the preset itself. */
export interface TeamApplicationOptions {
    /**
     * The deployment persona text an active complete preset supplied, kept
     * visible beside this Team's briefing when the captain states no prompt.
     */
    readonly personaFallback?: string;
    /**
     * The native tool presentation a prepared caller established.
     *
     * A custom policy needs a native surface, and an Agent scope accepts exactly
     * one presentation declaration: the prepared caller owns this install and its
     * verification, so the guard must not declare a second one. The install is
     * part of the application's rollback region.
     */
    readonly presentation?: {
        /**
         * Disclosure of the effective presentation, when applying the Team actually
         * overrode the Agent preset's own declaration.
         */
        readonly disclosure?: string | undefined;
        /** Declare the presentation and return the disposer that releases it. */
        readonly install: () => () => void;
    };
}
/**
 * Reject a Team this Session cannot apply, before any registration is touched.
 *
 * `tools.restrict` owns the authority on which global names an allow-list may
 * carry, and the probe applies and lifts it so the real application still
 * registers exactly one restriction. Every other registration a Team needs —
 * the two prompt sections and the member tool — uses names and orders fixed by
 * this plugin, so a captain allow-list naming an unknown tool is the failure an
 * adoption can actually hit. Callers check before releasing a running
 * application, so a refused preset never leaves a Session without one.
 * @param agent - the live Session agent about to take the Team.
 * @param team - the Team preset about to be applied.
 * @throws when the captain's custom allow-list names a tool this Session cannot restrict.
 */
export declare function assertTeamApplicable(agent: Agent, team: TeamPreset): void;
/**
 * Reject a Team whose allow-list names a capability this Session does not have.
 *
 * The settings catalog is the union of every standing Agent preset's tools, not
 * what one Session can actually call: a `minimal` Session composes no file
 * tools, so an allow-list naming one cannot be honoured. It is refused with the
 * missing names instead of being widened to the default-all policy or silently
 * trimmed, and the tool is never added just because the catalog lists it.
 * @param agent - the live Session agent about to take the Team.
 * @param team - the Team preset about to be applied.
 * @returns the refusal text, or undefined when every named capability is reachable.
 */
export declare function capabilityRefusal(agent: Agent, team: TeamPreset): string | undefined;
/**
 * Apply one Team preset to one live Session.
 *
 * A later call for the same Session replaces the previous application.
 * @param ctx - the plugin context providing the Team and Session services.
 * @param agent - the live Session agent taking the Team.
 * @param team - the Team preset to apply.
 * @param providers - continuable-subagent providers the member tool spawns through.
 * @param stored - reads the latest stored definition of this Team, so a member
 *   spawned later runs on its current route; defaults to the applied definition.
 * @param members - the durable member runtime that freezes each summoned
 *   member's configuration before creation; without one the member tool refuses
 *   rather than creating a member nothing could re-scope.
 * @returns the applied Team, whose `dispose` releases every registration.
 */
export declare function applyTeamToAgent(ctx: Context, agent: Agent, team: TeamPreset, providers: MemberProviders, stored?: StoredTeam, members?: MemberRuntime, options?: TeamApplicationOptions): TeamApplication;
/** Session identity helper kept with the application so both call sites brand identically. */
export type AppliedSessionId = SessionId;
