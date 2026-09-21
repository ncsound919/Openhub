import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import {
  discoverEndpoints,
  validateContract,
  executeRequest,
  startMockServer,
  stopMockServer,
  getMockServerStatus,
} from '../src/services/apiStudio.js';
import { createApiStudioRouter } from '../src/routes/apiStudioRoutes.js';
import { clearReceipts, listReceipts } from '../src/services/receipts.js';

describe('Interactive API Studio & Mock Engine (Phase E3)', () => {
  let tempDir: string;

  beforeEach(async () => {
    clearReceipts();
    await stopMockServer();
    delete process.env.OPENHUB_ALLOW_PRIVATE_FETCH;
    delete process.env.OPENHUB_WEBHOOK_ALLOW_PRIVATE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-studio-test-'));
  });

  afterEach(async () => {
    await stopMockServer();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('Endpoint Discovery', () => {
    it('discovers endpoints from openapi.json', () => {
      const openApiSpec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              summary: 'List users',
              tags: ['Users'],
              responses: {
                '200': {
                  description: 'List of users',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
            post: {
              summary: 'Create user',
              tags: ['Users'],
            },
          },
        },
      };

      fs.writeFileSync(path.join(tempDir, 'openapi.json'), JSON.stringify(openApiSpec));

      const endpoints = discoverEndpoints(tempDir);
      expect(endpoints.length).toBeGreaterThanOrEqual(2);
      expect(endpoints.some((e) => e.path === '/users' && e.method === 'GET')).toBe(true);
      expect(endpoints.some((e) => e.path === '/users' && e.method === 'POST')).toBe(true);
    });

    it('scans Express source files for registered routes', () => {
      const srcDir = path.join(tempDir, 'src', 'routes');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'items.ts'),
        `
        router.get('/items', getAllItems);
        router.post('/items', createItem);
        router.delete('/items/:id', deleteItem);
        `,
      );

      const endpoints = discoverEndpoints(tempDir);
      expect(endpoints.some((e) => e.path === '/items' && e.method === 'GET')).toBe(true);
      expect(endpoints.some((e) => e.path === '/items' && e.method === 'POST')).toBe(true);
      expect(endpoints.some((e) => e.path === '/items/:id' && e.method === 'DELETE')).toBe(true);
    });
  });

  describe('Contract Schema Validation', () => {
    it('validates compliant JSON payloads against schema', () => {
      const schema = {
        type: 'object',
        required: ['id', 'name', 'active'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          active: { type: 'boolean' },
        },
      };

      const result = validateContract({ id: 'u_123', name: 'Alice', active: true }, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects missing required fields and type mismatches', () => {
      const schema = {
        type: 'object',
        required: ['id', 'count'],
        properties: {
          id: { type: 'string' },
          count: { type: 'number' },
        },
      };

      const result = validateContract({ id: 'u_123', count: 'NOT_A_NUMBER' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Expected 'count' to be number"))).toBe(true);
    });
  });

  describe('Autonomous Mock Engine', () => {
    it('starts HTTP mock server, generates synthesized schema data, and terminates gracefully', async () => {
      const mockPort = 4077;
      const endpoints = [
        {
          id: 'GET:/api/profile',
          method: 'GET' as const,
          path: '/api/profile',
          responses: {
            '200': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  score: { type: 'number' },
                  verified: { type: 'boolean' },
                },
              },
            },
          },
        },
      ];

      const config = await startMockServer(endpoints, mockPort, 10, 0);
      expect(config.active).toBe(true);
      expect(config.port).toBe(mockPort);

      // Verify running status
      const status = getMockServerStatus();
      expect(status.active).toBe(true);

      // Make HTTP call to mock server
      const res = await fetch(`http://localhost:${mockPort}/api/profile`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-mock-server')).toBe('OpenHub-Autonomous-Mock');

      const data = await res.json();
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('score');
      expect(data).toHaveProperty('verified');

      await stopMockServer();
      const stoppedStatus = getMockServerStatus();
      expect(stoppedStatus.active).toBe(false);
    });
  });

  describe('Request Execution & Evidence Receipts', () => {
    it('executes HTTP requests with environment templating and emits signed receipt', async () => {
      // Spin up tiny echo server for testing
      const testServer = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ message: 'Hello from echo', authHeader: req.headers['authorization'] }));
      });

      await new Promise<void>((resolve) => testServer.listen(4088, resolve));

      // This test deliberately targets a local echo server; the SSRF guard
      // blocks loopback unless the operator opts in.
      process.env.OPENHUB_ALLOW_PRIVATE_FETCH = '1';
      try {
        const result = await executeRequest({
          url: 'http://localhost:4088/test',
          method: 'GET',
          headers: { Authorization: 'Bearer {{API_TOKEN}}' },
          envVars: { API_TOKEN: 'secret_jwt_token_xyz' },
          expectedSchema: {
            type: 'object',
            required: ['message'],
          },
        });

        expect(result.status).toBe(200);
        expect(result.body.message).toBe('Hello from echo');
        expect(result.body.authHeader).toBe('Bearer secret_jwt_token_xyz');
        expect(result.contractValid).toBe(true);
        expect(result.receiptId).toBeDefined();

        const receipts = listReceipts();
        expect(receipts.some((r) => r.command.includes('HTTP GET'))).toBe(true);
      } finally {
        delete process.env.OPENHUB_ALLOW_PRIVATE_FETCH;
        await new Promise<void>((resolve) => testServer.close(() => resolve()));
      }
    });

    it('blocks a loopback target by default (SSRF guard)', async () => {
      const result = await executeRequest({ url: 'http://127.0.0.1:4089/private', method: 'GET' });
      // The guard refuses before any fetch, so the execution reports no status.
      expect(result.status).toBe(0);
    });
  });

  describe('REST Endpoints', () => {
    it('handles endpoints discovery, request execution, and mock control', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/studio', createApiStudioRouter());

      // 1. GET /api/studio/endpoints
      const epRes = await request(app).get(`/api/studio/endpoints?dir=${encodeURIComponent(tempDir)}`);
      expect(epRes.status).toBe(200);
      expect(epRes.body.ok).toBe(true);

      // 2. GET /api/studio/mock/status
      // The router's envelope is { ok, config } — this asserted a `data` key
      // the route has never returned.
      const statusRes = await request(app).get('/api/studio/mock/status');
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.config.active).toBe(false);

      // 3. POST /api/studio/mock/start
      const startRes = await request(app).post('/api/studio/mock/start').send({
        port: 4092,
        latencyMs: 10,
        endpoints: [{ id: 'GET:/ping', method: 'GET', path: '/ping' }],
      });
      expect(startRes.status).toBe(200);
      expect(startRes.body.config.active).toBe(true);

      // 4. POST /api/studio/mock/stop
      const stopRes = await request(app).post('/api/studio/mock/stop');
      expect(stopRes.status).toBe(200);
      expect(stopRes.body.ok).toBe(true);
    });
  });
});
