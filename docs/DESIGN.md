# DESIGN.md — Overlay365 OpenHub Dark

> Dense dark mission-control console for OpenHub: one accent, mono numerics, flat elevation, motion <=200ms, WCAG AA. Encodes the opencode+OpenHub design rules.
> Generated from OG-Glass preset `overlay365-openhub-dark` (`validate` 100, `grade` S/100; deterministic, zero LLM).
> Token source of truth: `docs/tokens.css`. Follow this contract for spacing, typography, colour, depth, motion and component look.

## 1. Visual Theme & Atmosphere

- **Mood:** overlay365, dark, dashboard, dense, mission-control, b2b
- **Density:** comfortable
- **Design philosophy:** Density + consistency + calm: cockpit density, one accent, monospace for all technical values. Flat elevation: borders and dividers over shadows; no gratuitous glass or blur. Motion is functional only, <=200ms, transform/opacity, honour prefers-reduced-motion. WCAG AA contrast; semantic status colours (success/warning/danger) reserved for status, never decoration.

## 2. Color Palette & Roles

| Token | Value | Role |
|---|---|---|
| `color-background` | #0b0c0e | Main surface |
| `color-surface` | #171a20 | Cards, raised panels |
| `color-border` | #262a31 | Dividers, input borders |
| `color-overlay` | #0b0c0e | Modals, overlays |
| `color-primary` | #5e6ad2 | Primary actions |
| `color-primaryHover` | #727ce0 | Accent: primaryHover |
| `color-secondary` | #8b93ef | Accent: secondary |
| `color-danger` | #e5484d | Error states |
| `color-success` | #4caf7d | Success states |
| `color-warning` | #d8a13a | Accent: warning |
| `color-text-primary` | #e9ebee | Body and headings |
| `color-text-secondary` | #9aa1ab | Secondary text |
| `color-text-muted` | #8a919c | Muted text |

## 3. Typography Rules

| Level | Font | Size | Weight | Usage |
|---|---|---|---|---|
| Display | `'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif` | 2.25rem / 700 | Hero headlines |
| H1 | `'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif` | 1.875rem / 600 | H1 text |
| H2 | `'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif` | 1.5rem / 600 | H2 text |
| H3 | `'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif` | 1.25rem / 600 | H3 text |
| Body | `'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif` | 0.875rem / 400 | Body text |
| Small | `'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif` | 0.8125rem / 600 | Small text |
| Mono | `'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | 0.8125rem / 600 | Code, ids, hashes, numbers, timestamps |

- Line height: 1.5
- **Rule:** every technical value (ids, hashes, counts, timestamps, code) is set in `--typography-fontFamily-mono`. This is not optional.

## 4. Spacing & Layout

- Spacing scale: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128 (4pt base)
- Card radius: 10px | Card padding: 16px | Card gap: 12px
- Sidebar: 260px (collapsed 64px)

## 5. Depth & Elevation

| Level | Treatment | Usage |
|---|---|---|
| 0 | `blur(0px)` | Flat surfaces |
| 1 | `blur(0px)` | Cards |
| 2 | `blur(0px)` | Sidebar, panels |
| 3 | `blur(0px)` | Modals |
| 4 | `blur(0px)` | Popovers, tooltips |

- Glass tint: `rgba(255, 255, 255, 0.03)` | shadow: `rgba(0, 0, 0, 0.50)`
- **Rule:** flat by default — borders and dividers over shadows. Reserve shadow for overlays only. No gratuitous glass.

## 6. Component Stylings

- **Avatar** (data): User avatar with initials fallback and status dot.
- **Badge** (data): Status badge with tone variants (success/info/warning/danger/neutral).
- **DataTable** (data): Sortable data table with tokenized borders, header fills, and row hover.
- **EmptyState** (data): Empty/zero-data state with icon, title, description, and optional action.
- **ProgressBar** (data): Accessible progress bar with role=progressbar and deterministic value.
- **StatCard** (data): KPI stat card with label, value, delta badge, and optional accent.
- **Alert** (feedback): Inline alert with success/error/info/warning tones and role=alert.
- **Modal** (feedback): Overlay modal with elevated surface, title, and close action.
- **Skeleton** (feedback): Loading placeholder with pulsing animation and aria-busy.
- **Toast** (feedback): Transient toast notification with success/error tones.
- **Tooltip** (feedback): Accessible tooltip with role=tooltip, elevation, and hover/focus triggers.
- **Button** (navigation): Action button with primary/secondary/danger/ghost variants and disabled + loading states.
- **NavGroup** (navigation): Sidebar navigation group with collapsible header and NavItem children.
- **Pagination** (navigation): Accessible pagination with prev/next, page buttons, and aria-current.
- **Tabs** (navigation): Accessible tab bar with role=tablist, active state, and keyboard-friendly buttons.
- **Checkbox** (settings): Accessible checkbox with label, disabled state, and focus-visible ring.
- **FormField** (settings): Labeled input field with error state and tokenized focus ring.
- **OptionGroup** (settings): Settings section container with labeled group header.
- **Select** (settings): Accessible select with label, error, and disabled states.
- **Switch** (settings): Accessible toggle switch with on/off states and disabled state.
- **Sidebar** (shell): Collapsible sidebar with NavGroup support.
- **GlassCard** (surface): Card surface with highlight border (blur resolves to 0px under this preset — effectively flat).

## 7. Do's and Don'ts

- DO: use the token palette exactly — never introduce colors outside it.
- DO: keep spacing on the 4pt grid.
- DO: use the declared type scale and font families only.
- DO: keep elevation flat where the palette has no glass tokens.
- DON'T: add drop shadows not present in the depth table.
- DON'T: use more than the two declared font families (body + mono).
- DON'T: hardcode px values that are off the spacing scale.

## 8. Agent Prompt Guide

Quick reference: primary `#5e6ad2`, background `#0b0c0e`, radius `10px`, spacing base `4px`.

> Use the DESIGN.md file in the project root as the visual reference for all styling decisions. Follow the spacing, typography, and color palette exactly.

---

## Provenance & audit

- **Canonical brand source:** `BUSINESS/brand/` (`rules/design-rules.md`, `color/`, `logos/`, `tokens/`). This DESIGN.md is the OpenHub application of those rules — keep it in sync with the brand repo.
- Preset `overlay365-openhub-dark` (OG-Glass, `SKILLS/Skilltech/OG-Glass/presets/`), `extends: glassmorphic-base`. Verified `validate_preset` 100 and `grade_design` **S/100** (0 contrast failures, 0 4pt-grid violations, 0 type-order violations).
- Token values reuse OpenHub's existing dark tokens (`src/index.css`) — not invented.
- **Correction:** the OG-Glass DESIGN.md export prints the *body* font family in the Mono row; corrected here to `JetBrains Mono` to match `docs/tokens.css` (`--typography-fontFamily-mono`). Worth a fix upstream.
- The full 22-component React kit is reproducible on demand: `og-glass generate_ui_kit preset_id=overlay365-openhub-dark`. It is not copied into `src/` (OpenHub styles with Tailwind classes; the kit uses inline styles).
