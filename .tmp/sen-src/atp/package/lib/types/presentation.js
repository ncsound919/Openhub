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
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
/**
 * Read the effective prompt and tool surface of one Agent.
 *
 * This is the final wire the model receives: restricted, shadowed, and with an
 * active complete section already reduced to the sole section. It is the only
 * authority used here — no private presentation state is inspected.
 * @param agent - the live Agent whose next request is being shaped.
 * @returns the snapshot, or undefined when assembly itself failed.
 */
export async function readWire(agent) {
    try {
        const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent));
        return {
            sections: assembly.sections.map(section => ({ name: section.name, text: section.text })),
            tools: assembly.tools.map(tool => tool.name),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Disclosure the settings page renders when a custom Team policy replaced a PTC
 * presentation.
 *
 * A locale key, not prose: the Host never guesses the reader's language, and the
 * browser bundle carries the copy in both locales.
 */
export const PTC_OVERRIDDEN_DISCLOSURE = 'presentation.ptcOverridden';
/**
 * Decide how a custom policy's native presentation can be established.
 *
 * The read of the wire happens before any declaration is attempted, and the
 * probe declaration is released immediately, so the caller's real registration
 * is the only one in effect and is never blocked by this probe.
 * @param agent - the Agent the Team is being applied to.
 * @returns the typed preparation result.
 */
export async function prepareNativePresentation(agent) {
    const before = await readWire(agent);
    if (before === undefined) {
        return {
            kind: 'unknown',
            reason: 'This Session\'s effective tool presentation could not be read, so a strict custom tool policy cannot be '
                + 'applied to it; the Team was not applied.',
        };
    }
    if (!before.tools.includes(RUN_CODE_NAME))
        return { kind: 'already-native' };
    let probe;
    try {
        probe = agent.ctx.tools.presentAs('native');
    }
    catch (error) {
        return {
            kind: 'conflict',
            reason: 'This Session\'s exact Agent scope already declares a tool presentation that includes the PTC transport, '
                + 'and one composition may declare only one presentation per scope. A strict custom tool policy cannot govern '
                + 'that transport, so the Team was not applied here: choose a Team with the "all" tool mode, or select an Agent '
                + `preset that calls tools natively. (${String(error)})`,
        };
    }
    probe();
    return { kind: 'installable', disclosure: PTC_OVERRIDDEN_DISCLOSURE };
}
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
export function installNativePresentation(agent) {
    return agent.ctx.tools.presentAs('native');
}
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
export function personaBaseline(sections) {
    if (sections.length !== 1)
        return { kind: 'none' };
    const only = sections[0];
    return only.name === PERSONA_PREFIX_SECTION
        ? { kind: 'persona', text: only.text }
        : { kind: 'foreign', name: only.name };
}
