/**
 * Self-hosted Monaco (CSP-safe).
 *
 * `@monaco-editor/react` defaults to loading the editor core from the jsDelivr
 * CDN, which OpenHub's Content-Security-Policy (`script-src 'self'`) blocks —
 * leaving every editor surface dead (open/save/diff/typecheck). Point the
 * loader at the bundled `monaco-editor` package and serve its language workers
 * same-origin instead. Imported once for side effects by `src/main.tsx`.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

const monacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};
(self as unknown as Record<string, unknown>).MonacoEnvironment = monacoEnvironment;

loader.config({ monaco });

export default monaco;
