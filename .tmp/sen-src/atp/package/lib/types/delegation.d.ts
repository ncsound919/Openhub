/**
 * Creation admission for preset-managed Team members.
 *
 * Creating a member is a new delegation generation, so the host's subagent
 * settings apply to it exactly as they do to the native delegation tools:
 *
 * - `subagents.resolveMaxDepth()` is the configured absolute depth cap, and the
 *   caller's own depth is read through the official `delegationDepthOf()`
 *   helper so a session header, not a volatile option, decides it;
 * - a fixed member route is validated against the live LLM registry before any
 *   durable intent or roster row exists, so an unusable route is refused with
 *   the exact reason instead of failing inside the member's first turn or
 *   silently falling back to the Team Lead's route.
 *
 * Both checks fail closed: a missing service, an unreadable cap, or an
 * unverifiable route refuses the creation rather than being read as "no limit".
 * The host's own atomic continuation capacity stays the only concurrency gate;
 * this module never counts running rows of its own.
 * @module dsh-agent-team-presets/delegation
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
/** One member's configured route, as the frozen snapshot carries it. */
export interface MemberRouteRef {
    /** LLM provider route id. */
    readonly provider: string;
    /** Provider-owned model id. */
    readonly model: string;
    /** Adapter-owned reasoning effort, when the slot configured one. */
    readonly reasoningEffort?: string | undefined;
}
/**
 * Refuse a creation whose child depth the host's configured cap does not allow.
 *
 * The check is about the NEXT generation only: waking an existing member again
 * is not another delegation level, so a lowered cap never invalidates the
 * identity of a member that already exists.
 * @param ctx - the plugin context carrying the subagent service.
 * @param caller - the Agent summoning the member.
 * @returns the refusal text, or undefined when the creation may proceed.
 */
export declare function depthRefusal(ctx: Context, caller: Agent): string | undefined;
/**
 * Refuse a creation edge whose child the current depth cap no longer allows.
 *
 * This re-checks the admission on the awaited creation edge, where the child
 * Agent already exists: a settings change that landed while the creation was in
 * flight must not slip a member past the cap it was measured against. It is
 * only consulted for a creation that had no child yet — waking an existing
 * member again is not another generation.
 * @param ctx - the plugin context carrying the subagent service.
 * @param child - the child Agent being created.
 * @returns the refusal text, or undefined when the child may be created.
 */
export declare function createdDepthRefusal(ctx: Context, child: Agent): string | undefined;
/**
 * Refuse a member whose configured fixed route is not usable in this deployment.
 *
 * An empty route means the member runs on the Session's own route, which the
 * session already proved usable, so there is nothing to verify. A configured
 * route is validated with the same public call the Host uses before dispatch —
 * `llm.resolveCallConfig()` — which rejects an unsupported explicit reasoning
 * effort before any provider I/O and never clamps it. The advisory model
 * catalog is deliberately not required to list the model: core routing accepts
 * ids it does not advertise, but a route the deployment cannot resolve at all
 * is refused before anything durable is written.
 * @param ctx - the plugin context carrying the LLM registry.
 * @param route - the member's configured route, or undefined when it inherits the Session route.
 * @returns the refusal text, or undefined when the route may be used.
 */
export declare function routeRefusal(ctx: Context, route: MemberRouteRef | undefined): Promise<string | undefined>;
