// Unit tests for the Monaco provider wiring (src/ide/monacoProviders.ts):
// prefs gating, single-line truncation, tab stats, inline-edit accept/reject
// and jump-to-next-edit — with a fake Monaco API and a mocked browser client,
// so no browser is needed.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ide/axiomEditorClient', () => ({
  axiomEditorComplete: vi.fn(),
  axiomEditorIndex: vi.fn(),
  axiomEditorInlineEdit: vi.fn(),
  axiomEditorNextEdit: vi.fn(),
  axiomEditorTelemetry: vi.fn(),
}));

import {
  axiomEditorComplete,
  axiomEditorInlineEdit,
  axiomEditorNextEdit,
} from '../src/ide/axiomEditorClient';
import {
  registerAxiomMonaco,
  setAxiomMonacoOptions,
  getAxiomTabStats,
  nextWordChunk,
} from '../src/ide/monacoProviders';
import { applyHunks } from '../src/ide/inlineDiff';

function fakeMonaco() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inline: Record<string, { provideInlineCompletions: (...args: any[]) => any; handlePartialAccept?: (...args: any[]) => any }> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: Record<string, { provideCompletionItems: (...args: any[]) => any }> = {};
  const monaco = {
    languages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerInlineCompletionsProvider: (lang: string, p: any) => { inline[lang] = p; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerCompletionItemProvider: (lang: string, p: any) => { items[lang] = p; },
      CompletionItemKind: { File: 1 },
    },
    Range: class {
      sL: number; sC: number; eL: number; eC: number;
      constructor(sL: number, sC: number, eL: number, eC: number) {
        this.sL = sL; this.sC = sC; this.eL = eL; this.eC = eC;
      }
    },
    KeyMod: { CtrlCmd: 1, Alt: 2 },
    KeyCode: { KeyI: 1, KeyJ: 2 },
  };
  return { monaco, inline, items };
}

function fakeEditor(opts: { model?: unknown; position?: { lineNumber: number; column: number } } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands: Array<{ kb: unknown; handler: (...a: any[]) => unknown; ctx?: unknown }> = [];
  const calls: { edits: unknown[]; undoStops: number; triggers: unknown[]; positions: unknown[] } = {
    edits: [], undoStops: 0, triggers: [], positions: [],
  };
  const editor = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addAction: (a: any) => { actions[a.id] = a; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addCommand: (kb: any, handler: (...a: any[]) => any, ctx?: any) => { commands.push({ kb, handler, ctx }); },
    pushUndoStop: () => { calls.undoStops += 1; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executeEdits: (_s: unknown, e: any) => { calls.edits.push(e); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trigger: (...a: any) => { calls.triggers.push(a); },
    revealLineInCenter: (l: number) => { calls.positions.push({ reveal: l }); },
    setPosition: (p: unknown) => { calls.positions.push({ set: p }); },
    focus: () => {},
    getModel: () => opts.model ?? ({
      uri: { path: '/proj/src/a.ts' },
      getValue: () => 'const a = 1;\n',
      getValueInRange: () => 'const a = 1;',
      getLineContent: () => 'const a = 1;',
    }),
    getPosition: () => (opts.position ? { ...opts.position } : { lineNumber: 2, column: 1 }),
    getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 13 }),
  };
  return { editor, actions, commands, calls };
}

const modelAt = (content: string, col: number) => ({
  uri: { path: '/proj/src/a.ts' },
  getValue: () => content,
  getLineContent: () => content.split('\n')[0] ?? '',
});
const pos = { lineNumber: 1, column: 11 };

beforeEach(() => {
  vi.clearAllMocks();
  setAxiomMonacoOptions({ projectPath: '/proj', completionEnabled: true, completionDelayMs: 0, singleLine: false, onStatus: () => {} });
});

function mount(opts: Record<string, unknown> = {}, editorOpts: { model?: unknown; position?: { lineNumber: number; column: number } } = {}) {
  const { monaco, inline, items } = fakeMonaco();
  const { editor, actions, commands, calls } = fakeEditor(editorOpts);
  const statuses: string[] = [];
  registerAxiomMonaco(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monaco as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor as any,
    { projectPath: '/proj', onStatus: (m: string) => statuses.push(m), ...opts },
  );
  return { monaco, inline, items, editor, actions, commands, calls, statuses };
}

describe('inline completions prefs', () => {
  it('stays silent (no request) when completions are disabled', async () => {
    const { inline } = mount({ completionEnabled: false });
    const res = (await inline.typescript.provideInlineCompletions(modelAt('const a = ', 11), pos, {}, {})) as { items: unknown[] };
    expect(res.items).toEqual([]);
    expect(axiomEditorComplete).not.toHaveBeenCalled();
  });

  it('truncates ghost text at the first newline in single-line mode', async () => {
    vi.mocked(axiomEditorComplete).mockResolvedValue({ proxyMs: 2, data: { text: 'aaa\nbbb', source: 'local-model', latencyMs: 5, lane: 'chat' } });
    const { inline } = mount({ singleLine: true });
    const res = (await inline.typescript.provideInlineCompletions(modelAt('const a = ', 11), pos, {}, {})) as { items: Array<{ insertText: string }> };
    expect(res.items).toHaveLength(1);
    expect(res.items[0].insertText).toBe('aaa');
  });

  it('keeps multi-line ghost text by default and records tab stats', async () => {
    vi.mocked(axiomEditorComplete).mockResolvedValue({ proxyMs: 2, data: { text: 'aaa\nbbb', source: 'local-model', latencyMs: 40, lane: 'fim' } });
    const before = getAxiomTabStats().shown;
    const { inline } = mount({});
    const res = (await inline.typescript.provideInlineCompletions(modelAt('const a = ', 11), pos, {}, {})) as {
      items: Array<{ insertText: string }>; enableForwardStability: boolean;
    };
    expect(res.items[0].insertText).toBe('aaa\nbbb');
    expect(res.enableForwardStability).toBe(true);
    const after = getAxiomTabStats();
    expect(after.shown).toBe(before + 1);
    expect(after.lastLane).toBe('fim');
    expect(after.lastTotalMs).toBe(42);
  });
});

describe('inline edit accept/reject', () => {
  it('applies the edit, then accept keeps it and rejects complain when idle', async () => {
    (globalThis as { window?: unknown }).window = { prompt: () => 'do it' };
    vi.mocked(axiomEditorInlineEdit).mockResolvedValue({ data: { text: 'const a = 2;', source: 'local-model' } });
    const { actions, calls, statuses, editor } = mount({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.inlineEdit'] as any).run(editor);
    expect(calls.edits).toHaveLength(1);
    expect(statuses.some((s) => s.includes('Accept'))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.acceptInlineEdit'] as any).run(editor);
    expect(statuses.some((s) => s.includes('accepted'))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.rejectInlineEdit'] as any).run(editor);
    expect(statuses.some((s) => s.includes('no pending'))).toBe(true);
    delete (globalThis as { window?: unknown }).window;
  });

  it('reject restores the original text exactly (no undo dependency)', async () => {
    (globalThis as { window?: unknown }).window = { prompt: () => 'do it' };
    vi.mocked(axiomEditorInlineEdit).mockResolvedValue({ data: { text: 'const a = 2;', source: 'local-model' } });
    const { actions, calls, editor } = mount({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.inlineEdit'] as any).run(editor);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.rejectInlineEdit'] as any).run(editor);
    // Two edits: the insert, then the byte-exact restore. No undo triggered.
    expect(calls.edits).toHaveLength(2);
    const restore = (calls.edits[1] as Array<{ text: string }>)[0];
    expect(restore.text).toBe('const a = 1;');
    expect(calls.triggers).toHaveLength(0);
    delete (globalThis as { window?: unknown }).window;
  });

  it('registers per-hunk accept/reject and rebuilds the buffer for a subset', async () => {
    (globalThis as { window?: unknown }).window = { prompt: () => 'do it' };
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
    const after = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj';
    vi.mocked(axiomEditorInlineEdit).mockResolvedValue({ data: { text: after, source: 'local-model' } });
    const model = { uri: { path: '/proj/src/a.ts' }, getValue: () => before, getValueInRange: () => before, getLineContent: () => 'a' };
    const { actions, calls, editor } = mount({}, { model });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.inlineEdit'] as any).run(editor);
    expect(actions['axiom.inlineEdit.rejectHunk.0']).toBeDefined();
    expect(actions['axiom.inlineEdit.acceptHunk.1']).toBeDefined();

    const baseline = calls.edits.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.inlineEdit.rejectHunk.0'] as any).run();
    expect(calls.edits.length).toBe(baseline + 1);
    const last = calls.edits[calls.edits.length - 1] as Array<{ text: string }>;
    expect(last[0].text).toBe(applyHunks(before, after, [1]));

    // Re-accepting the hunk restores the full proposed text.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.inlineEdit.acceptHunk.0'] as any).run();
    const last2 = calls.edits[calls.edits.length - 1] as Array<{ text: string }>;
    expect(last2[0].text).toBe(after);
    delete (globalThis as { window?: unknown }).window;
  });

  it('reject falls back to undo when the buffer moved on since the apply', async () => {
    (globalThis as { window?: unknown }).window = { prompt: () => 'do it' };
    vi.mocked(axiomEditorInlineEdit).mockResolvedValue({ data: { text: 'const a = 2;', source: 'local-model' } });
    let version = 1;
    const model = {
      uri: { path: '/proj/src/a.ts' },
      getValue: () => 'const a = 1;\n',
      getValueInRange: () => 'const a = 1;',
      getLineContent: () => 'const a = 1;',
      getVersionId: () => version,
    };
    const { actions, calls, editor } = mount({}, { model, position: { lineNumber: 1, column: 1 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.inlineEdit'] as any).run(editor);
    version += 1; // an intervening edit moves the buffer on
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.rejectInlineEdit'] as any).run(editor);
    expect(calls.triggers).toHaveLength(1);
    expect((calls.triggers[0] as unknown[])[1]).toBe('undo');
    delete (globalThis as { window?: unknown }).window;
  });
});

describe('nextWordChunk', () => {
  it('takes leading whitespace plus the first word', () => {
    expect(nextWordChunk(' return 42;')).toBe(' return');
    expect(nextWordChunk('a\nb')).toBe('a');
    expect(nextWordChunk('\nfoo')).toBe('\n');
    expect(nextWordChunk('   ')).toBe('   ');
  });
});

describe('partial word accept', () => {
  it('registers Ctrl+Right scoped to visible ghost text only', () => {
    const { commands } = mount({});
    expect(commands).toHaveLength(1);
    expect(commands[0].ctx).toBe('inlineSuggestionVisible');
  });

  it('inserts the first word and serves the remainder with no second request', async () => {
    vi.mocked(axiomEditorComplete).mockResolvedValue({
      proxyMs: 1, data: { text: ' return 42;', source: 'local-model', latencyMs: 9, lane: 'fim' },
    });
    // A live-ish model: edits bump the version, the cursor tracks the insert.
    let version = 11;
    let text = 'function sq(n: number) {';
    const posRef = { lineNumber: 1, column: 24 };
    const shared = {
      uri: { path: '/proj/src/a.ts' },
      getValue: () => text,
      getLineContent: () => text,
      getVersionId: () => version,
    };
    const { monaco, inline, commands, calls } = (() => {
      const f = fakeMonaco();
      const e = fakeEditor({
        model: shared,
        position: posRef,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as { model: unknown; position: { lineNumber: number; column: number } });
      // Emulate the editor: inserts mutate the buffer, bump the version, move the cursor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e.editor as any).executeEdits = (_s: unknown, edits: Array<{ text: string }>) => {
        const ins = edits[0].text;
        text = text.slice(0, posRef.column - 1) + ins + text.slice(posRef.column - 1);
        version += 1;
        posRef.column += ins.length;
        e.calls.edits.push(edits);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e.editor as any).getPosition = () => ({ ...posRef });
      const statuses: string[] = [];
      registerAxiomMonaco(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        f.monaco as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        e.editor as any,
        { projectPath: '/proj', onStatus: (m: string) => statuses.push(m) },
      );
      return { ...f, ...e };
    })();

    const first = (await inline.typescript.provideInlineCompletions(shared, { ...posRef }, {}, {})) as {
      items: Array<{ insertText: string }>;
    };
    expect(first.items[0].insertText).toBe(' return 42;');
    expect(vi.mocked(axiomEditorComplete)).toHaveBeenCalledTimes(1);

    commands[0].handler();
    const inserted = (calls.edits[0] as Array<{ text: string }>)[0].text;
    expect(inserted).toBe(' return');

    const second = (await inline.typescript.provideInlineCompletions(shared, { ...posRef }, {}, {})) as {
      items: Array<{ insertText: string }>;
    };
    expect(second.items[0].insertText).toBe(' 42;');
    expect(vi.mocked(axiomEditorComplete)).toHaveBeenCalledTimes(1);
    expect(getAxiomTabStats().partialAccepts).toBeGreaterThan(0);
    expect(monaco).toBeTruthy();
  });
});

describe('jump to next edit', () => {
  it('moves the cursor to the same-file candidate', async () => {
    vi.mocked(axiomEditorNextEdit).mockResolvedValue({
      data: { candidates: [{ file: 'src/a.ts', line: 7, reason: 'definition of a' }] },
    });
    const { actions, calls, editor, statuses } = mount({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.jumpToNextEdit'] as any).run(editor);
    expect(calls.positions).toContainEqual({ set: { lineNumber: 7, column: 1 } });
    expect(statuses.some((s) => s.includes('line 7'))).toBe(true);
  });

  it('names the file instead of jumping when the candidate is elsewhere', async () => {
    vi.mocked(axiomEditorNextEdit).mockResolvedValue({
      data: { candidates: [{ file: 'src/other.ts', line: 3 }] },
    });
    const { actions, calls, editor, statuses } = mount({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (actions['axiom.jumpToNextEdit'] as any).run(editor);
    expect(calls.positions).toEqual([]);
    expect(statuses.some((s) => s.includes('src/other.ts'))).toBe(true);
  });
});
