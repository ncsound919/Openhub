/**
 * Durable identity of preset-managed Team members.
 *
 * The member snapshot in `./member-store.ts` is the frozen configuration, but
 * it lives in a unit this plugin opens: when that unit cannot be opened, is
 * damaged, or lost a record, the snapshot alone cannot tell a member this
 * plugin created from a native teammate. A member therefore also carries an
 * identity that the HOST persists on its own: the subagent execution backend it
 * was created through.
 *
 * This plugin registers two stable aliases in the official subagent provider
 * registry — one per configured spawn context — and summons every member
 * through them. The official Team service writes the provider name into its
 * roster row and into the child's own `subagent/descriptor`, so the child can
 * later prove it is plugin-managed even when no snapshot can be read. The
 * aliases are execution backends, never LLM routes: each one delegates the
 * whole provider contract to the deployment's own provider, so fresh/fork
 * history semantics, cancellation, and concurrency isolation are unchanged.
 *
 * Aliases therefore have to exist exactly while their upstream provider does,
 * whatever order the two plugins activate in. The registry built here is
 * self-maintaining: it scans once when it subscribes, follows
 * `subagent/provider-added` and `subagent/provider-removed` afterwards, and
 * re-validates every alias whenever its upstream may have changed. Nothing
 * about the mount order of this plugin and the provider plugins is assumed, and
 * no alias failure is remembered past the moment it stops being true.
 *
 * @module dsh-agent-team-presets/member-identity
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
/** Alias a fresh member is created through; persisted by the Host as its provider. */
export declare const MEMBER_FRESH_PROVIDER = "preset-member-fresh-v1";
/** Alias a forked member is created through; persisted by the Host as its provider. */
export declare const MEMBER_FORK_PROVIDER = "preset-member-fork-v1";
/**
 * Whether one execution-backend name is this plugin's member marker.
 * @param name - a subagent provider name, from a roster row or a child descriptor.
 * @returns whether this plugin owns that name.
 */
export declare function isPresetMemberProvider(name: string | undefined): boolean;
/**
 * Read the identity marker one child carries in its own durable suffix.
 *
 * The first `subagent/descriptor` a session wrote is the one that established
 * it. A descriptor whose mode is not `continuable` is not a Team member this
 * plugin could have created, so its `provider` is never treated as a marker;
 * only the establishing continuable descriptor is read, and never a later one.
 * @param agent - the live child Agent.
 * @returns the provider name of its establishing descriptor, or undefined.
 */
export declare function memberProviderMarker(agent: Agent): string | undefined;
/** The provider aliases one activation registered, and why it could not. */
export interface MemberProviderAliases {
    /** Alias a fresh member must be created through. */
    readonly fresh: string;
    /** Alias a forked member must be created through. */
    readonly fork: string;
    /**
     * Why a FRESH member cannot be created, when the fresh alias is unusable.
     *
     * Reported instead of falling back to the deployment's own provider: a member
     * created without the alias would carry no marker, and would then be
     * indistinguishable from a native teammate after a restart. The value is read
     * on every access, so it clears as soon as the alias becomes registrable.
     */
    readonly freshError?: string | undefined;
    /** Why a FORKED member cannot be created, when the fork alias is unusable. */
    readonly forkError?: string | undefined;
}
/** The provider aliases one activation registered, with their release. */
export interface MemberProviderRegistry extends MemberProviderAliases {
    /** Release every alias this activation registered, and stop following the registry. */
    dispose(): void;
}
/**
 * Resolve the alias one spawn context must be created through.
 *
 * Called at member-creation time, so the answer is read from the aliases that
 * exist NOW rather than from the state one startup scan happened to observe: a
 * provider that registered after this plugin activated is usable, and one that
 * has since been removed is refused.
 * @param registry - the aliases this activation maintains.
 * @param context - the configured spawn context of the member about to be created.
 * @returns the alias to spawn through, or the refusal for that context.
 */
export declare function memberProviderFor(registry: MemberProviderAliases, context: 'fresh' | 'fork'): {
    readonly name: string;
} | {
    readonly error: string;
};
/** Why one spawn context is currently unusable, or that it is usable. */
export type MemberProviderUnavailable =
/** The configured upstream name is empty. */
'unconfigured'
/** The configured upstream name is this plugin's own alias. */
 | 'alias'
/** The deployment registers no provider under the configured name (yet). */
 | 'missing'
/** The configured provider cannot create continuable children. */
 | 'unsupported'
/** The alias could not be registered, or the provider lookup threw. */
 | 'registration';
/**
 * Report one spawn context becoming usable or unusable.
 *
 * Called only when a context's availability actually changes, so a caller can
 * log a refusal once instead of once per registry event. `missing` is the
 * expected state while a provider plugin is still loading, which is why it is
 * reported separately from the states that mean the configuration is wrong.
 * @param context - the spawn context that changed.
 * @param state - the new state, or undefined once the alias is usable.
 * @param reason - human-readable refusal for the new state.
 */
export type MemberProviderAvailability = (context: 'fresh' | 'fork', state: MemberProviderUnavailable | undefined, reason: string) => void;
/**
 * Register the member aliases, delegating to the configured providers, and keep
 * them in step with the provider registry for as long as this activation lives.
 *
 * The two spawn contexts are independent: a deployment that composes only a
 * fresh provider still serves fresh members, while a forked member is refused
 * with the reason its own backend is unusable. A configured name that is itself
 * an alias is always refused — the wrapper must never become its own backend —
 * and so is a name whose provider cannot create continuable children, or whose
 * alias registration fails. A configured name the deployment does not (or does
 * not yet) register is refused only while it stays absent: the aliases are
 * re-validated on every provider registry event, so a provider that activates
 * later is picked up without restarting this plugin, and one that is replaced
 * has its wrapper rebound to the new object.
 *
 * Registration failure is reported per context rather than skipped: a member
 * created through the deployment's own provider would carry no marker and could
 * not be told apart from a native teammate after a restart.
 * @param ctx - the plugin context carrying the subagent service.
 * @param configured - the deployment's fresh/fork provider names from the plugin config.
 * @param onAvailability - optional observer of each context's availability change.
 * @returns the maintained aliases, whose `dispose` releases every registration.
 */
export declare function registerMemberProviders(ctx: Context, configured: {
    readonly fresh: string;
    readonly fork: string;
}, onAvailability?: MemberProviderAvailability): MemberProviderRegistry;
