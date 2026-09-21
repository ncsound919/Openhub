import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { recordReceipt } from './receipts.js';
import { fetchWithUrlGuard } from './webhooks.js';

export interface DiscoveredEndpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  summary?: string;
  category?: string;
  parameters?: Array<{ name: string; in: 'path' | 'query' | 'header'; required?: boolean; type?: string }>;
  requestBodySchema?: Record<string, any>;
  responses?: Record<string, { description?: string; schema?: Record<string, any>; example?: any }>;
}

export interface RequestExecutionResult {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Record<string, string>;
  body: any;
  bodyBytes: number;
  contractValid?: boolean;
  contractErrors?: string[];
  receiptId?: string;
}

export interface MockServerConfig {
  port: number;
  active: boolean;
  latencyMs: number;
  errorRate: number; // 0.0 to 1.0
  endpointsCount: number;
}

let activeMockServer: http.Server | null = null;
let currentMockConfig: MockServerConfig = {
  port: 4050,
  active: false,
  latencyMs: 30,
  errorRate: 0,
  endpointsCount: 0,
};

/**
 * Discover API endpoints by scanning OpenAPI / Swagger files and Express routes in targetDir.
 */
export function discoverEndpoints(targetDir: string): DiscoveredEndpoint[] {
  const endpoints: DiscoveredEndpoint[] = [];
  const seen = new Set<string>();

  const add = (ep: Omit<DiscoveredEndpoint, 'id'>) => {
    const id = `${ep.method}:${ep.path}`;
    if (!seen.has(id)) {
      seen.add(id);
      endpoints.push({ id, ...ep });
    }
  };

  // 1. Scan for openapi / swagger files
  const candidates = [
    'openapi.json',
    'swagger.json',
    'api-spec.json',
    'openapi.yaml',
    'swagger.yaml',
  ];

  for (const c of candidates) {
    const fPath = path.join(targetDir, c);
    if (fs.existsSync(fPath) && c.endsWith('.json')) {
      try {
        const spec = JSON.parse(fs.readFileSync(fPath, 'utf8'));
        if (spec.paths) {
          for (const [rPath, methods] of Object.entries<any>(spec.paths)) {
            for (const [m, def] of Object.entries<any>(methods)) {
              const upperM = m.toUpperCase() as DiscoveredEndpoint['method'];
              if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(upperM)) {
                add({
                  method: upperM,
                  path: rPath,
                  summary: def.summary || def.description,
                  category: Array.isArray(def.tags) ? def.tags[0] : undefined,
                  parameters: def.parameters,
                  requestBodySchema: def.requestBody?.content?.['application/json']?.schema,
                  responses: def.responses,
                });
              }
            }
          }
        }
      } catch {
        /* continue to next candidate */
      }
    }
  }

  // 2. Scan source files for Express router definitions if few/no endpoints were found
  if (endpoints.length < 5) {
    const routesDir = path.join(targetDir, 'src', 'routes');
    if (fs.existsSync(routesDir)) {
      try {
        const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
        for (const file of files) {
          const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
          const routeRegex = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
          let m: RegExpExecArray | null;
          const category = file.replace(/\.(routes\.)?(ts|js)$/, '');
          while ((m = routeRegex.exec(content)) !== null) {
            const method = m[1].toUpperCase() as DiscoveredEndpoint['method'];
            // Report the route AS WRITTEN. The previous version prefixed
            // `/api/<filename>`, inventing a mount point this scan cannot
            // know — `router.get('/items')` in items.ts became
            // `/api/items/items`, an endpoint that does not exist. The file
            // name is still carried as the category.
            const raw = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
            const epPath = raw.replace(/\/{2,}/g, '/');
            add({
              method,
              path: epPath,
              summary: `${method} handler from ${file}`,
              category,
            });
          }
        }
      } catch {
        /* best-effort */
      }
    }
  }

  // Fallback defaults if workspace is clean/new
  if (endpoints.length === 0) {
    endpoints.push(
      { id: 'GET:/api/health', method: 'GET', path: '/api/health', summary: 'Service health check', category: 'system' },
      { id: 'GET:/api/users', method: 'GET', path: '/api/users', summary: 'List platform users', category: 'users' },
      { id: 'POST:/api/auth/login', method: 'POST', path: '/api/auth/login', summary: 'User authentication', category: 'auth' },
    );
  }

  return endpoints;
}

/**
 * Validate a response payload against a simplified JSON schema.
 */
export function validateContract(payload: any, schema?: Record<string, any>): { valid: boolean; errors: string[] } {
  if (!schema || typeof schema !== 'object') return { valid: true, errors: [] };
  const errors: string[] = [];

  if (schema.type === 'object' && schema.required && Array.isArray(schema.required)) {
    if (typeof payload !== 'object' || payload === null) {
      errors.push(`Expected response body to be object, got ${typeof payload}`);
    } else {
      for (const reqField of schema.required) {
        if (payload[reqField] === undefined) {
          errors.push(`Missing required response field: "${reqField}"`);
        }
      }
    }
  }

  if (schema.type && typeof payload === 'object' && payload !== null) {
    if (schema.type === 'array' && !Array.isArray(payload)) {
      errors.push('Expected response body to be an array');
    }
  }

  // Property TYPES were never checked, so `{ count: 'NOT_A_NUMBER' }`
  // validated cleanly against `{ count: { type: 'number' } }` — "contract
  // validation" that validated only field presence.
  if (
    schema.type === 'object'
    && schema.properties
    && typeof schema.properties === 'object'
    && typeof payload === 'object'
    && payload !== null
    && !Array.isArray(payload)
  ) {
    for (const [key, rawSpec] of Object.entries<any>(schema.properties)) {
      const value = (payload as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue; // presence is required[]'s job
      const expected = rawSpec?.type;
      if (typeof expected !== 'string') continue;
      if (!matchesJsonType(value, expected)) {
        errors.push(`Expected '${key}' to be ${expected}, got ${actualJsonType(value)}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** The JSON Schema type name for a runtime value. */
function actualJsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Whether `value` satisfies a JSON Schema primitive type name. */
function matchesJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null': return value === null;
    default: return true; // unknown type keyword: do not invent a failure
  }
}

/**
 * Execute an HTTP request with templating, latency timing, and schema contract validation.
 */
export async function executeApiRequest(options: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: any;
  expectedSchema?: Record<string, any>;
  envVars?: Record<string, string>;
  timeoutMs?: number;
}): Promise<RequestExecutionResult> {
  const startedAt = Date.now();

  // 1. Template URL and headers with environment variables
  let finalUrl = options.url;
  const env = options.envVars || {};
  for (const [k, v] of Object.entries(env)) {
    finalUrl = finalUrl.replaceAll(`{{${k}}}`, v);
  }

  const reqHeaders: Record<string, string> = {
    'User-Agent': 'OpenHub-API-Studio/1.0',
    ...(options.headers || {}),
  };

  for (const [hKey, hVal] of Object.entries(reqHeaders)) {
    for (const [k, v] of Object.entries(env)) {
      reqHeaders[hKey] = reqHeaders[hKey].replaceAll(`{{${k}}}`, v);
    }
  }

  let reqBody: string | undefined;
  if (options.body && ['POST', 'PUT', 'PATCH'].includes(options.method.toUpperCase())) {
    reqBody = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
  }

  try {
    // SSRF guard: the URL is request-supplied. `fetchWithUrlGuard` re-checks
    // every redirect hop, so a public target that 30x-redirects into
    // loopback/private space is refused too.
    const res = await fetchWithUrlGuard(
      finalUrl,
      {
        method: options.method,
        headers: reqHeaders,
        body: reqBody,
        signal: AbortSignal.timeout(options.timeoutMs || 10_000),
      },
      { label: 'API Studio request URL' },
    );

    const durationMs = Date.now() - startedAt;
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    const rawText = await res.text();
    const bodyBytes = Buffer.byteLength(rawText, 'utf8');

    let parsedBody: any = rawText;
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      /* plain text */
    }

    // Validate schema contract
    const contract = validateContract(parsedBody, options.expectedSchema);

    // Record receipt
    let receiptId: string | undefined;
    try {
      const receipt = recordReceipt({
        kind: 'command',
        command: `HTTP ${options.method} ${finalUrl}`,
        status: res.ok && contract.valid ? 'passed' : 'failed',
        durationMs,
        output: `HTTP ${res.status} ${res.statusText} (${bodyBytes} bytes). Contract: ${contract.valid ? 'VALID' : 'INVALID'}`,
        exitCode: res.status,
      });
      receiptId = receipt.id;
    } catch {
      /* best-effort */
    }

    return {
      status: res.status,
      statusText: res.statusText,
      durationMs,
      headers: resHeaders,
      body: parsedBody,
      bodyBytes,
      contractValid: contract.valid,
      contractErrors: contract.errors,
      receiptId,
    };
  } catch (err: any) {
    return {
      status: 0,
      statusText: err.name === 'TimeoutError' ? 'Request Timeout' : 'Connection Error',
      durationMs: Date.now() - startedAt,
      headers: {},
      body: { error: err.message || 'Connection failed' },
      bodyBytes: 0,
      contractValid: false,
      contractErrors: [err.message || 'Connection failed'],
    };
  }
}

/**
 * Generate synthetic realistic mock responses based on schema types.
 */
function synthesizeMockData(schema?: Record<string, any>): any {
  if (!schema) return { ok: true, message: 'OpenHub mock response' };

  if (schema.example) return schema.example;
  if (schema.type === 'string') return 'mock_string_value';
  if (schema.type === 'number' || schema.type === 'integer') return 42;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') return [synthesizeMockData(schema.items)];

  if (schema.type === 'object' || schema.properties) {
    const obj: Record<string, any> = {};
    const props = schema.properties || {};
    for (const [k, v] of Object.entries<any>(props)) {
      obj[k] = synthesizeMockData(v);
    }
    return obj;
  }

  return { id: 'mock_123', status: 'success', timestamp: new Date().toISOString() };
}

/**
 * Start the autonomous in-process HTTP mock server.
 */
export async function startMockServer(endpoints: DiscoveredEndpoint[], port = 4050, latencyMs = 30, errorRate = 0): Promise<MockServerConfig> {
  if (activeMockServer) {
    await stopMockServer();
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || '/', `http://localhost:${port}`);
      const reqPath = parsedUrl.pathname;
      const reqMethod = (req.method || 'GET').toUpperCase();

      // Error simulation
      if (errorRate > 0 && Math.random() < errorRate) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OpenHub Simulated Mock Error', status: 500 }));
        return;
      }

      // Find matching endpoint
      const matched = endpoints.find((ep) => ep.method === reqMethod && (ep.path === reqPath || reqPath.startsWith(ep.path.replace(/:[^/]+/g, ''))));

      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Mock-Server', 'OpenHub-Autonomous-Mock');

        if (matched) {
          const respDef = matched.responses?.['200'] || matched.responses?.['201'] || Object.values(matched.responses || {})[0];
          const mockData = synthesizeMockData(respDef?.schema);
          res.writeHead(200);
          res.end(JSON.stringify(mockData, null, 2));
        } else {
          res.writeHead(200);
          res.end(
            JSON.stringify(
              {
                ok: true,
                mock: true,
                path: reqPath,
                method: reqMethod,
                timestamp: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        }
      }, latencyMs);
    });

    server.listen(port, () => {
      activeMockServer = server;
      currentMockConfig = {
        port,
        active: true,
        latencyMs,
        errorRate,
        endpointsCount: endpoints.length,
      };
      resolve(currentMockConfig);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Stop active mock server.
 */
export async function stopMockServer(): Promise<void> {
  if (activeMockServer) {
    return new Promise((resolve) => {
      activeMockServer?.close(() => {
        activeMockServer = null;
        currentMockConfig.active = false;
        resolve();
      });
    });
  }
  currentMockConfig.active = false;
}

export function getMockServerStatus(): MockServerConfig {
  return { ...currentMockConfig };
}

export const executeRequest = executeApiRequest;
