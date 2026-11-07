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
/** Alias a fresh member is created through; persisted by the Host as its provider. */
export const MEMBER_FRESH_PROVIDER = 'preset-member-fresh-v1';
/** Alias a forked member is created through; persisted by the Host as its provider. */
export const MEMBER_FORK_PROVIDER = 'preset-member-fork-v1';
/** The two spawn contexts, in the fixed order their aliases are maintained. */
const CONTEXTS = ['fresh', 'fork'];
/** Every alias this plugin registers. The set is fixed and versioned. */
const ALIASES = new Set([MEMBER_FRESH_PROVIDER, MEMBER_FORK_PROVIDER]);
/**
 * Whether one execution-backend name is this plugin's member marker.
 * @param name - a subagent provider name, from a roster row or a child descriptor.
 * @returns whether this plugin owns that name.
 */
export function isPresetMemberProvider(name) {
    return name !== undefined && ALIASES.has(name);
}
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
export function memberProviderMarker(agent) {
    for (const event of agent.session.ownEvents()) {
        if (event.type !== 'subagent/descriptor')
            continue;
        const data = event.data;
        if (data.mode !== 'continuable')
            return undefined;
        return typeof data.provider === 'string' ? data.provider : undefined;
    }
    return undefined;
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
export function memberProviderFor(registry, context) {
    const error = context === 'fresh' ? registry.freshError : registry.forkError;
    if (error !== undefined)
        return { error };
    return { name: context === 'fresh' ? registry.fresh : registry.fork };
}
/**
 * Build the delegating alias for one configured provider.
 *
 * The wrapper is a pass-through: it copies the upstream start-time facts and
 * forwards both provider methods to the provider the deployment configured. It
 * never replaces the upstream object, never adds a capability the backend does
 * not declare, and never holds the child handle the continuation manager owns.
 * @param alias - the registry name this plugin persists as its marker.
 * @param upstream - the deployment's configured provider.
 * @returns the provider registered under the alias.
 */
function aliasProvider(alias, upstream) {
    const start = upstream.start;
    const prepareContinuable = upstream.prepareContinuable;
    return {
        name: alias,
        capabilities: upstream.capabilities,
        inheritsParentContext: upstream.inheritsParentContext,
        ...upstream.agentRouteDefaults === undefined ? {} : { agentRouteDefaults: upstream.agentRouteDefaults },
        // 0.2.1 made `start` optional on the provider contract (a continuable-only
        // backend omits it), so the alias mirrors exactly the members it delegates.
        ...start === undefined ? {} : { start: (request) => start(request) },
        ...prepareContinuable === undefined
            ? {}
            : { prepareContinuable: (request) => prepareContinuable(request) },
    };
}
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
export function registerMemberProviders(ctx, configured, onAvailability = () => { }) {
    const states = {
        fresh: { alias: MEMBER_FRESH_PROVIDER, upstreamName: configured.fresh, upstream: undefined, release: undefined, failure: undefined, reported: false },
        fork: { alias: MEMBER_FORK_PROVIDER, upstreamName: configured.fork, upstream: undefined, release: undefined, failure: undefined, reported: false },
    };
    let disposed = false;
    // Reentrancy guard. Registering or releasing an alias is itself a provider
    // registry event, so every public path that reaches the registry can be
    // entered again from inside it; the outermost call owns the whole sweep.
    let reconciling = false;
    /**
     * Look up an upstream provider without letting a broken registry take the
     * plugin down: the Settings page and the preset tools belong to such a
     * deployment; only member creation has no channel.
     * @param name - the configured upstream provider name.
     * @returns the provider, or the refusal kind and reason instead.
     */
    const lookup = (name) => {
        const subagents = ctx.get('subagents');
        if (subagents === undefined) {
            return {
                state: 'missing',
                reason: 'this deployment composes no subagent service, so a Team member cannot be created through '
                    + 'this plugin\'s identity alias.',
            };
        }
        try {
            const provider = subagents.getProvider(name);
            return provider === undefined
                ? { state: 'missing', reason: `this deployment registers no subagent provider named "${name}".` }
                : { provider };
        }
        catch (error) {
            return { state: 'registration', reason: `the subagent providers could not be read: ${String(error)}` };
        }
    };
    /**
     * Release one context's live alias, if it has one.
     *
     * The upstream is cleared BEFORE the registration is released, so the
     * `subagent/provider-removed` this release emits cannot be mistaken for the
     * deployment withdrawing the provider, and cannot re-enter this sweep.
     * @param state - the context whose alias is released.
     */
    const detach = (state) => {
        const release = state.release;
        state.release = undefined;
        state.upstream = undefined;
        if (release !== undefined)
            release();
    };
    /**
     * Report one context's availability, once per actual change.
     * @param state - the context whose registration was updated.
     * @param context - the spawn context, for the availability report.
     */
    const report = (state, context) => {
        const failure = state.failure;
        if (failure === undefined) {
            // A usable alias is never reported as a recovery: the transient state a
            // provider plugin passes through while loading is not an incident.
            state.reported = false;
            return;
        }
        if (state.reported)
            return;
        state.reported = true;
        onAvailability(context, failure.state, failure.reason);
    };
    /**
     * Record why one context is unusable, releasing the alias it may still hold.
     *
     * A refusal with a different *kind* than the one already standing is a new
     * fact — a provider that was merely absent and now actively cannot back a
     * member, for instance — so it is reported even though the context was
     * already unusable.
     * @param state - the context to refuse.
     * @param reason - the refusal a member creation must report.
     * @param failureState - the category of the refusal.
     * @param context - the spawn context, for the availability report.
     */
    const fail = (state, reason, failureState, context) => {
        detach(state);
        const previous = state.failure;
        // A repeat of the same refusal is not news; a refusal that changed kind or
        // wording is.
        if (previous?.state !== failureState || previous.reason !== reason)
            state.reported = false;
        state.failure = { state: failureState, reason };
        report(state, context);
    };
    /**
     * Validate one context and register, rebind, or release its alias to match.
     *
     * Registration happens only on a real change — no live alias, or a live alias
     * still delegating to the same upstream object — so the events this function
     * causes can never make it re-register what it just registered.
     * @param context - the spawn context to reconcile.
     */
    const reconcile = (context) => {
        const state = states[context];
        if (state.upstreamName.trim() === '') {
            fail(state, `the ${context} subagent provider is not configured, so a ${context} member cannot be created `
                + 'without losing the identity that proves it is preset-managed.', 'unconfigured', context);
            return;
        }
        if (isPresetMemberProvider(state.upstreamName)) {
            fail(state, `the ${context} subagent provider "${state.upstreamName}" is this plugin's own member alias; point `
                + 'the plugin at the deployment provider it should delegate to.', 'alias', context);
            return;
        }
        const found = lookup(state.upstreamName);
        if ('state' in found) {
            fail(state, found.state === 'missing'
                ? found.reason + ` A ${context} member cannot be created through this plugin's identity alias.`
                : found.reason, found.state, context);
            return;
        }
        const { provider } = found;
        if (provider.prepareContinuable === undefined) {
            fail(state, `subagent provider "${state.upstreamName}" cannot create continuable children, so it cannot back `
                + `a ${context} Team member.`, 'unsupported', context);
            return;
        }
        // The upstream is live and usable, so the previous refusal no longer
        // describes it. It is cleared only once the alias is actually registered,
        // so a registration failure never leaves this context usable-looking.
        if (state.upstream === provider) {
            state.failure = undefined;
            report(state, context);
            return;
        }
        // A replaced provider object must never stay behind a wrapper: release the
        // old alias first, then bind the new object.
        detach(state);
        try {
            const release = ctx.get('subagents')?.registerProvider(aliasProvider(state.alias, provider));
            if (release === undefined) {
                fail(state, `the ${context} member execution alias "${state.alias}" could not be registered: the subagent `
                    + 'service was released while it was being registered.', 'registration', context);
                return;
            }
            state.upstream = provider;
            state.release = release;
        }
        catch (error) {
            fail(state, `the ${context} member execution alias "${state.alias}" could not be registered: ${String(error)}`, 'registration', context);
            return;
        }
        state.failure = undefined;
        report(state, context);
    };
    /**
     * Re-validate both contexts. Never runs inside another sweep: the events a
     * registration or release emits re-enter here, and the outer sweep already
     * covers them.
     */
    const sweep = () => {
        if (disposed || reconciling)
            return;
        reconciling = true;
        try {
            // `fresh` first: a forked member must never be the reason a fresh member
            // is unavailable, and neither context's failure is allowed to abort the
            // other's registration.
            for (const context of CONTEXTS)
                reconcile(context);
        }
        finally {
            reconciling = false;
        }
    };
    /**
     * Follow the provider registry for as long as this activation lives.
     *
     * Only providers this plugin does not own are interesting: its own aliases
     * arrive here too, and following them would be a self-loop. The listeners are
     * registered before the initial scan so a registration that lands in between
     * is not missed.
     * @param name - the provider name the event names, for `provider-added` and `provider-removed` alike.
     */
    const follow = (name) => {
        if (disposed || isPresetMemberProvider(name))
            return;
        sweep();
    };
    const disposers = [];
    disposers.push(ctx.on('subagent/provider-added', (provider) => { follow(provider.name); }));
    disposers.push(ctx.on('subagent/provider-removed', (name) => { follow(name); }));
    // One initial scan covers a deployment whose providers were already
    // registered when this activation mounted.
    sweep();
    return {
        get fresh() { return states.fresh.alias; },
        get fork() { return states.fork.alias; },
        get freshError() { return states.fresh.failure?.reason; },
        get forkError() { return states.fork.failure?.reason; },
        dispose: () => {
            if (disposed)
                return;
            disposed = true;
            // Stop following first: releasing the aliases emits provider-removed, and
            // an unloaded activation must never resurrect an alias. The listeners are
            // taken back off in reverse registration order.
            for (const off of disposers.splice(0).reverse())
                void off();
            for (const context of CONTEXTS) {
                const state = states[context];
                detach(state);
                state.failure = undefined;
            }
        },
    };
}
