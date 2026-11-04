import { MCPClient } from '../mcp-client.js';
import {
  createTondoResearch,
  describeTondoResearch,
  type TondoResearch,
} from '../services/tondoResearch.js';

export interface DiagnosisResult {
  rootCause: string;
  fixStrategy: 'replace' | 'add_import' | 'add_dep' | 'fix_config' | 'retry' | 'unknown';
  fixCode: string;
  affectedFile: string;
  fixDescription: string;
}

/** Tondo is optional: without a URL and key, OpenHub keeps its existing path. */
function tondoFromEnv(): TondoResearch | null {
  const baseUrl = process.env.TONDO_RESEARCH_URL ?? '';
  const token = process.env.TONDO_RESEARCH_KEY ?? '';
  if (!baseUrl || !token) return null;
  return createTondoResearch({ baseUrl, appId: 'openhub', token });
}

/**
 * Strip the shapes most likely to carry a credential or a developer's home
 * directory before any failure text leaves the process. This is a heuristic,
 * not a guarantee; the caller still sends only a bounded excerpt.
 */
function redact(value: string): string {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[user]')
    .slice(0, 900);
}

export class ErrorDiagnoser {
  constructor(
    private mcpClient: MCPClient,
    private tondo: TondoResearch | null = tondoFromEnv(),
  ) {}

  async diagnose(error: { stderr: string; command: string }): Promise<DiagnosisResult> {
    console.info(`[ErrorDiagnoser] Diagnosing error: ${error.stderr.slice(0, 100)}...`);

    let response: any = null;
    let mcpError: string | null = null;
    try {
      response = await this.mcpClient.callTool('vibe_audit', {
        files: [],
        requirements: [
          `Diagnose this build error:\nCommand: ${error.command}\nStderr: ${error.stderr}`,
          `Provide a fix in JSON format: { rootCause, fixStrategy, fixCode, affectedFile, fixDescription }`,
        ],
      });
    } catch (cause: any) {
      mcpError = cause?.message ? String(cause.message).slice(0, 300) : 'vibe_audit failed';
    }

    // The local audit tool can answer without a patch. That is the moment the
    // agent is stuck; ask Tondo for evidence and a safe next step rather than
    // pretending a file rewrite is known. Only a non-empty fixCode counts as
    // actionable from the audit tool.
    const mcpPatch = typeof response?.fixCode === 'string' ? response.fixCode.trim() : '';
    const needsHelp = Boolean(mcpError) || !mcpPatch;
    if (needsHelp && this.tondo) {
      try {
        const research = await this.tondo.assist({
          operation: 'build diagnosis',
          question: `Diagnose the ${error.command} failure and name the smallest safe next step.`,
          symptom: redact(error.stderr),
          context: `command: ${error.command.slice(0, 400)}\napp: OpenHub`,
          dataClass: 'internal',
        });
        return {
          rootCause: research.findings[0]?.claim ?? research.summary ?? mcpError ?? 'Unknown',
          fixStrategy: 'unknown',
          fixCode: '',
          affectedFile: '',
          fixDescription: describeTondoResearch(research),
        };
      } catch (cause: any) {
        console.warn(
          `[ErrorDiagnoser] Tondo did not answer: ${String(cause?.message ?? cause).slice(0, 120)}`,
        );
      }
    }

    return {
      rootCause: mcpError ?? 'Unknown',
      fixStrategy: 'unknown',
      fixCode: '',
      affectedFile: '',
      fixDescription: mcpError
        ? 'No diagnosis was produced; the agent should not rewrite a file.'
        : 'The audit tool returned no actionable diagnosis.',
    };
  }
}
