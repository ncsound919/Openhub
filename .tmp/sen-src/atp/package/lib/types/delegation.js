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
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
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
export function depthRefusal(ctx, caller) {
    const subagents = ctx.get('subagents');
    if (subagents === undefined) {
        return 'this deployment composes no subagent service, so a new Team member\'s delegation depth cannot be '
            + 'checked against the configured limit; creation is refused rather than assumed unlimited.';
    }
    let cap;
    try {
        cap = subagents.resolveMaxDepth();
    }
    catch (error) {
        return `the configured subagent depth limit could not be read (${String(error)}); creation is refused.`;
    }
    if (cap === undefined) {
        // The deployment explicitly put depth under the execution backend. This
        // plugin creates members through that same backend, so the backend's own
        // `depthLimit` capability governs it exactly as it governs a native child.
        return undefined;
    }
    if (!Number.isInteger(cap) || cap < 0) {
        return `the configured subagent depth limit (${String(cap)}) is not a non-negative integer; creation is refused.`;
    }
    let parentDepth;
    try {
        parentDepth = delegationDepthOf(caller);
    }
    catch (error) {
        return `the calling Agent's delegation depth could not be read (${String(error)}); creation is refused.`;
    }
    if (!Number.isInteger(parentDepth) || parentDepth < 0) {
        return `the calling Agent reports an invalid delegation depth (${String(parentDepth)}); creation is refused.`;
    }
    if (cap === 0) {
        return 'subagent delegation is disabled in this deployment (maximum depth 0), so no Team member can be created. '
            + 'Raise the subagent depth limit in the host settings to summon members.';
    }
    const childDepth = parentDepth + 1;
    if (childDepth > cap) {
        return `creating a Team member here would put it at delegation depth ${childDepth}, beyond the configured `
            + `subagent depth limit ${cap} (this Agent is at depth ${parentDepth}). No member was created.`;
    }
    return undefined;
}
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
export function createdDepthRefusal(ctx, child) {
    const subagents = ctx.get('subagents');
    if (subagents === undefined) {
        return 'this deployment composes no subagent service, so a new Team member\'s delegation depth cannot be '
            + 'verified at its creation edge; creation is refused rather than assumed unlimited.';
    }
    let cap;
    try {
        cap = subagents.resolveMaxDepth();
    }
    catch (error) {
        return `the configured subagent depth limit could not be read (${String(error)}); creation is refused.`;
    }
    if (cap === undefined)
        return undefined;
    if (!Number.isInteger(cap) || cap < 0) {
        return `the configured subagent depth limit (${String(cap)}) is not a non-negative integer; creation is refused.`;
    }
    let childDepth;
    try {
        childDepth = delegationDepthOf(child);
    }
    catch (error) {
        return `the new member's delegation depth could not be read (${String(error)}); creation is refused.`;
    }
    if (!Number.isInteger(childDepth) || childDepth < 0) {
        return `the new member reports an invalid delegation depth (${String(childDepth)}); creation is refused.`;
    }
    if (cap === 0) {
        return 'subagent delegation is disabled in this deployment (maximum depth 0), so no Team member can be created. '
            + 'Raise the subagent depth limit in the host settings to summon members.';
    }
    if (childDepth > cap) {
        return `this Team member would run at delegation depth ${childDepth}, beyond the configured subagent depth limit `
            + `${cap}. It is refused before its first request; raise the subagent depth limit to summon it.`;
    }
    return undefined;
}
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
export async function routeRefusal(ctx, route) {
    if (route === undefined)
        return undefined;
    const llm = ctx.get('llm');
    if (llm === undefined) {
        return `the member route "${route.provider}/${route.model}" cannot be verified because this deployment exposes `
            + 'no LLM registry; creation is refused rather than falling back to the Team Lead\'s route.';
    }
    let registered;
    try {
        registered = llm.listProviders().some(provider => provider.id === route.provider);
    }
    catch (error) {
        return `the LLM provider list could not be read (${String(error)}), so the member route `
            + `"${route.provider}/${route.model}" cannot be verified; creation is refused.`;
    }
    if (!registered) {
        return `the configured member route "${route.provider}/${route.model}" names an LLM provider this deployment does `
            + 'not register. Correct the member\'s provider in the Team preset or add that provider to the deployment.';
    }
    const effort = route.reasoningEffort === undefined ? '' : ` with reasoning effort "${route.reasoningEffort}"`;
    try {
        await llm.resolveCallConfig({
            provider: route.provider,
            model: route.model,
            ...route.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
        });
    }
    catch (error) {
        return `the configured member route "${route.provider}/${route.model}"${effort} is not usable in this deployment `
            + `(${String(error)}). Correct the member's route in the Team preset; creation is refused rather than falling `
            + 'back to the Team Lead\'s route or failing inside the member\'s first request.';
    }
    return undefined;
}
