// Pure parsing for Axiom's live model catalog.
//
// Axiom's `GET /api/pipeline/models` answers `{ groups, current }` where each
// group is `{ provider, label, models[] }` (see src/server/routes/system.ts).
// The provider groups are the right shape for a grouped picker, but the editor
// model dropdown wants one flat, de-duplicated list with the persisted default
// first. This module normalizes either shape and is unit-tested without a
// network or a DOM.

export interface ModelCatalogGroup {
  provider: string;
  label: string;
  models: string[];
}

export interface ModelCatalog {
  groups: ModelCatalogGroup[];
  /** Flat, de-duplicated model ids in provider order. */
  models: string[];
  /** The persisted default model, when Axiom reports one. */
  current: string | null;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseModelCatalog(raw: unknown): ModelCatalog {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawGroups = Array.isArray(obj.groups) ? obj.groups : [];
  const groups: ModelCatalogGroup[] = [];

  for (const entry of rawGroups) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const provider = typeof rec.provider === 'string' ? rec.provider.trim() : '';
    const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : provider;
    const models: string[] = [];
    if (Array.isArray(rec.models)) {
      for (const m of rec.models) {
        const id = cleanId(m);
        if (id) models.push(id);
      }
    }
    if (!provider && models.length === 0) continue;
    groups.push({ provider, label, models });
  }

  const models: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const m of g.models) {
      if (!seen.has(m)) { seen.add(m); models.push(m); }
    }
  }

  const current = cleanId(obj.current);
  return { groups, models, current };
}

/**
 * The ordered option list for the picker. The configured default comes first,
 * then the editor tier's own advertised models, then the broader provider
 * catalog — de-duplicated so the same id never appears twice.
 */
export function modelPickerOptions(
  catalog: ModelCatalog,
  extra: { configured?: string | null; models?: string[] } = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const id = cleanId(value);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  };
  push(extra.configured);
  for (const m of extra.models ?? []) push(m);
  for (const m of catalog.models) push(m);
  return out;
}
