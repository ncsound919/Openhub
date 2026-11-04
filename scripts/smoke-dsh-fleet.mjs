/**
 * Offline smoke for @overlay365/dsh-fleet: applies the bundle against a fake
 * ctx, emulates dsh conditional registration (`when`), and asserts the tool
 * surface — no dsh runtime, no network.
 *
 * Run: `node scripts/smoke-dsh-fleet.mjs` from openhub/.
 */
import assert from 'node:assert/strict';
import { apply } from '../dsh-plugins/openhub-fleet/index.js';

const registered = [];
const fakeCtx = {
  tools: {
    register(definition, opts = {}) {
      registered.push({ definition, when: opts.when });
      return () => {};
    },
  },
};

apply(fakeCtx);

// Emulate dsh: a tool with `{ when }` only registers while it holds.
const visible = registered.filter(({ when }) => (typeof when === 'function' ? when() : true));
const names = visible.map(({ definition }) => definition.name);

const hasToken = Boolean((process.env.ECOSYSTEM_CONTROL_TOKEN || process.env.CONTROL_TOKEN || '').trim());
const expected = hasToken
  ? ['fleet.status', 'fleet.service', 'telemetry.summary', 'voice.status']
  : ['telemetry.summary', 'voice.status'];

assert.deepEqual(names, expected, `visible tools mismatch (token ${hasToken ? 'set' : 'unset'}): ${names}`);

for (const { definition } of visible) {
  assert.match(definition.description, /.{20,}/, `${definition.name} needs a real description`);
  assert.equal(definition.output?.schema?.type, 'string', `${definition.name} output must be the string summary`);
  assert.equal(typeof definition.execute, 'function', `${definition.name} needs execute`);
}

const service = visible.find(({ definition }) => definition.name === 'fleet.service');
if (service) {
  // defineTool compiles the spec to standard JSON Schema (required: [...]).
  assert.ok(
    service.definition.parameters?.required?.includes('service'),
    'fleet.service.service must be required',
  );
}

console.log(`fleet bundle smoke OK: [${names.join(', ')}] (control token ${hasToken ? 'present' : 'absent'})`);
