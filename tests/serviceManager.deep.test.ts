import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  MANAGED_SERVICES,
  SERVICE_CATEGORIES,
  slugsInCategory,
  type ServiceCategory,
} from '../src/services/serviceManager.js';
import { createServicesLifecycleRouter } from '../src/routes/servicesLifecycle.js';

// The Fleet surface is only as good as the catalog it drives. These assert the
// grouping is coherent and that an unknown group is rejected (not silently run).
describe('service catalog + fleet grouping', () => {
  it('every managed service has a valid category', () => {
    for (const [slug, cfg] of Object.entries(MANAGED_SERVICES)) {
      expect(SERVICE_CATEGORIES as readonly string[]).toContain(cfg.category);
      expect(cfg.port).toBeGreaterThan(0);
      expect(typeof cfg.command).toBe('string');
      expect(cfg.slug).toBe(slug);
    }
  });

  it('slugsInCategory returns exactly the services of that category', () => {
    for (const cat of SERVICE_CATEGORIES as ServiceCategory[]) {
      const slugs = slugsInCategory(cat);
      const expected = Object.values(MANAGED_SERVICES).filter((s) => s.category === cat).map((s) => s.slug);
      expect(slugs.sort()).toEqual(expected.sort());
    }
    // The audit/repair teams the pipeline relies on exist.
    expect(slugsInCategory('audit').length).toBeGreaterThan(0);
  });

  it('rejects an unknown group with 400 instead of running anything', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createServicesLifecycleRouter({ authMiddleware: (_req, _res, next) => next() }));

    const res = await request(app).post('/api/lifecycle/groups/not-a-category/start').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('unknown category');
  });
});
