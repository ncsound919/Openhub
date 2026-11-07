/**
 * Tool-presentation preparation for one Team application.
 *
 * An official Agent preset declares its tool presentation for its own scope:
 * `standard` and `cordis` stay native, `ptc` declares `presentAs('ptc')`. A
 * strict custom Team policy has to reach the tools it allows, and the shipped
 * Node PTC transport can import `fs`/`child_process` outside the tool SDK, so a
 * custom Team is only ever applied with a native presentation of its own.
 *
 * That decision is made here through public APIs only: the effective wire is
 * read with `systemPrompt.assemble()`, and a native declaration is attempted
 * rather than assumed. The three outcomes are kept apart, because they need
 * different answers — an already-native surface needs nothing, an ancestor PTC
 * surface is shadowed by our own Agent-scoped declaration, and a presentation
 * an exact-Agent scope already declared cannot be replaced and must refuse the
 * application instead of silently running a surface the policy cannot govern.
 *
 * @module dsh-agent-team-presets/presentation
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
/** One read of the model-visible prompt surface of an Agent. */
export interface WireSnapshot {
    /** Effective prompt sections, in assembly order. */
    readonly sections: readonly {
        readonly name: string;
        readonly text: string;
    }[];
    /** Names of the tools this Agent's model would actually see. */
    readonly tools: readonly string[];
}
/**
 * Read the effective prompt and tool surface of one Agent.
 *
 * This is the final wire the model receives: restricted, shadowed, and with an
 * active complete section already reduced to the sole section. It is the only
 * authority used here — no private presentation state is inspected.
 * @param agent - the live Agent whose next request is being shaped.
 * @returns the snapshot, or undefined when assembly itself failed.
 */
export declare function readWire(agent: Agent): Promise<WireSnapshot | undefined>;
/** How a custom Team policy's native presentation can be established. */
export type NativePresentation =
/**
 * The effective surface is already native: no declaration is needed, and the
 * policy's allow-list governs it as it stands.
 */
{
    readonly kind: 'already-native';
}
/**
 * A PTC or both presentation was in effect and this plugin can shadow it at
 * the Agent's own scope. The caller must install the native declaration and
 * discloses the override with {@link PTC_OVERRIDDEN_DISCLOSURE}.
 */
 | {
    readonly kind: 'installable';
    readonly disclosure: string;
}
/**
 * The effective surface exposes the PTC transport and an exact-Agent
 * declaration cannot be replaced, so a custom policy cannot govern it.
 */
 | {
    readonly kind: 'conflict';
    readonly reason: string;
}
/** The effective surface could not be read, so nothing can be promised about it. */
 | {
    readonly kind: 'unknown';
    readonly reason: string;
};
/**
 * Disclosure the settings page renders when a custom Team policy replaced a PTC
 * presentation.
 *
 * A locale key, not prose: the Host never guesses the reader's language, and the
 * browser bundle carries the copy in both locales.
 */
export declare const PTC_OVERRIDDEN_DISCLOSURE = "presentation.ptcOverridden";
/**
 * Decide how a custom policy's native presentation can be established.
 *
 * The read of the wire happens before any declaration is attempted, and the
 * probe declaration is released immediately, so the caller's real registration
 * is the only one in effect and is never blocked by this probe.
 * @param agent - the Agent the Team is being applied to.
 * @returns the typed preparation result.
 */
export declare function prepareNativePresentation(agent: Agent): Promise<NativePresentation>;
/**
 * Declare the native presentation at the Agent's own scope.
 *
 * Separate from {@link prepareNativePresentation} so the caller installs it
 * inside its own rollback region: a throw here rolls back the whole
 * application instead of leaving a partially applied policy.
 * @param agent - the Agent the Team is being applied to.
 * @returns the disposer releasing the declaration.
 * @throws when the scope already declares another presentation.
 */
export declare function installNativePresentation(agent: Agent): () => void;
/** What the deployment's own persona slot contributes before this plugin applies a Team. */
export type PersonaBaseline =
/** No complete persona is active: the deployment's sections compose normally. */
{
    readonly kind: 'none';
}
/** The official complete persona slot is active; its text is captured verbatim. */
 | {
    readonly kind: 'persona';
    readonly text: string;
}
/** A complete section this plugin did not author and cannot safely re-declare. */
 | {
    readonly kind: 'foreign';
    readonly name: string;
};
/**
 * Classify the persona baseline of one wire snapshot.
 *
 * The official prompt service restores an active complete section as the SOLE
 * section, so a single-section snapshot is exactly the signature of a complete
 * deployment persona (the official `minimal` preset). Anything else — several
 * sections, or one section under a name this plugin does not own — means there
 * is no complete persona to preserve.
 * @param sections - the effective sections of a pre-application snapshot.
 * @returns the classified baseline.
 */
export declare function personaBaseline(sections: WireSnapshot['sections']): PersonaBaseline;
