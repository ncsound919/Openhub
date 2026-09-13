import { describe, it, expect } from 'vitest';
import {
  detectFileArchetype,
  extractExports,
  extractImports,
  analyzeSystemAndFiles,
  detectTheaterAndMocks,
  generateTestScaffold,
} from '../src/services/systemScanner';
import fs from 'fs';
import path from 'path';

describe('System Detection & File Recognition Engine', () => {
  it('should accurately recognize React component files', () => {
    const code = `import React from 'react';\nexport function MyButton() { return <button>Click</button>; }`;
    const archetype = detectFileArchetype('/src/components/MyButton.tsx', code);
    expect(archetype).toBe('react-component');
  });

  it('should accurately recognize API route & server files', () => {
    const code = `import express from 'express';\nconst app = express();\napp.get('/api/test', (req, res) => res.json({ ok: true }));`;
    const archetype = detectFileArchetype('/server.ts', code);
    expect(archetype).toBe('api-route');
  });

  it('should accurately recognize Database & Store files', () => {
    const code = `import Database from 'better-sqlite3';\nconst db = new Database('data.db');\nexport function getDb() { return db; }`;
    const archetype = detectFileArchetype('/src/auth/db.ts', code);
    expect(archetype).toBe('data-store');
  });

  it('should accurately recognize Agent & Orchestrator files', () => {
    const code = `export class PlannerAgent {\n  constructor(private mcpClient: any) {}\n}`;
    const archetype = detectFileArchetype('/orchestrator/agents/plannerAgent.ts', code);
    expect(archetype).toBe('agent-service');
  });

  it('should extract exported symbols reliably', () => {
    const code = `
      export function calculateMetric(a: number, b: number) { return a + b; }
      export async function fetchRemoteData() { return []; }
      export const DEFAULT_TIMEOUT = 5000;
      export class SystemEngine {}
      export default function MainView() {}
    `;
    const exports = extractExports(code);
    expect(exports).toContain('calculateMetric');
    expect(exports).toContain('fetchRemoteData');
    expect(exports).toContain('DEFAULT_TIMEOUT');
    expect(exports).toContain('SystemEngine');
    expect(exports).toContain('default');
  });

  it('should extract import dependencies', () => {
    const code = `
      import express from 'express';
      import { v4 } from 'uuid';
      import { getDb } from './src/auth/db.js';
    `;
    const imports = extractImports(code);
    expect(imports).toContain('express');
    expect(imports).toContain('uuid');
    expect(imports).toContain('./src/auth/db.js');
  });

  it('should analyze system and list untested candidates with breakdown', () => {
    const result = analyzeSystemAndFiles();
    expect(result.filesAnalyzed).toBeGreaterThan(0);
    expect(result.runtime.hasTypeScript).toBe(true);
    expect(result.runtime.hasVitest).toBe(true);
    expect(result.fileBreakdown['react-component']).toBeGreaterThan(0);
    expect(Array.isArray(result.untestedCandidates)).toBe(true);
  });

  it('should scaffold complete unit test for a utility file', () => {
    const tempDir = path.join(process.cwd(), 'tests', '.temp');
    const testGen = generateTestScaffold('src/services/webhooks.ts', process.cwd(), tempDir);
    expect(testGen.testFilePath).toBeDefined();
    expect(fs.existsSync(testGen.testFilePath)).toBe(true);
    expect(testGen.code).toContain('describe');
    expect(testGen.code).toContain('it');

    // Clean up temporary generated test
    if (fs.existsSync(testGen.testFilePath)) {
      fs.unlinkSync(testGen.testFilePath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });
});

describe('Mock, Stub, Placeholder & Theater Detection Engine', () => {
  it('should detect theater patterns and return detailed occurrences', () => {
    const scan = detectTheaterAndMocks();
    expect(scan).toHaveProperty('clean');
    expect(scan).toHaveProperty('theaterScore');
    expect(scan).toHaveProperty('totalOccurrences');
    expect(scan).toHaveProperty('byCategory');
    expect(scan).toHaveProperty('occurrences');
    expect(Array.isArray(scan.occurrences)).toBe(true);

    // Each occurrence must have line number, file, and suggestion
    for (const occ of scan.occurrences) {
      expect(occ.file).toBeDefined();
      expect(occ.line).toBeGreaterThan(0);
      expect(occ.content).toBeDefined();
      expect(occ.category).toBeDefined();
      expect(occ.severity).toBeDefined();
      expect(occ.suggestion).toBeDefined();
    }
  });

  it('should categorize mock data variables and placeholder markers appropriately', () => {
    const scan = detectTheaterAndMocks();
    const categories = Object.keys(scan.byCategory);
    expect(categories).toContain('mock_data');
    expect(categories).toContain('stub_implementation');
    expect(categories).toContain('placeholder_marker');
    expect(categories).toContain('simulated_latency');
    expect(categories).toContain('theater_endpoint');
  });
});
