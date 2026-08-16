# Travel Footprint Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a responsive, single-file global city travel map with offline city search, cached administrative boundaries, local backup, and PNG poster export.

**Architecture:** TypeScript modules expose pure domain, city-index, map, storage, boundary, and poster interfaces. A thin UI shell composes them. Vite builds the app; a post-build step inlines all same-origin assets into one HTML file.

**Tech Stack:** TypeScript 5, Vite 7, Vitest 3, Playwright 1, fake-indexeddb, SVG, IndexedDB, Web Workers.

## Global Constraints

- All implementation changes stay on `feature/travel-map-v1` in `repos/travel-footprint-map`.
- Final artifact is one self-contained HTML that works from `file://` and GitHub Pages.
- Never use or bind port 8080; local E2E uses port 4179.
- UI is Simplified Chinese, responsive at 360px, keyboard accessible, and respects reduced motion.
- Notes are plain text, maximum 500 Unicode code points.
- Boundary responses and imported backups are untrusted and must be validated before persistence/rendering.
- Public Nominatim requests are user-triggered, serialized to at most 1 request/second, cached, attributed, and never used for autocomplete.

---

### Task 1: Foundation and domain contracts

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `index.html`
- Create: `src/domain/types.ts`, `src/domain/validation.ts`, `src/domain/validation.test.ts`, `src/main.ts`, `src/styles.css`

**Interfaces:**
- Produces: `CitySummary`, `VisitRecord`, `CachedBoundary`, `BackupV1`, `DatePrecision`, `validateVisitDate`, `sanitizeNote`.

- [ ] **Step 1: Write failing domain tests** for year/month/day formats, invalid leap days, whitespace-only notes, and the 500-code-point limit.

```ts
expect(validateVisitDate('2024-02-29')).toEqual({ value: '2024-02-29', precision: 'day' });
expect(() => validateVisitDate('2023-02-29')).toThrow('日期无效');
expect(sanitizeNote('  海边散步  ')).toBe('海边散步');
```

- [ ] **Step 2: Run** `npm test -- src/domain/validation.test.ts` and confirm failure because the module is missing.
- [ ] **Step 3: Implement the domain types and pure validation functions.** Use calendar validation rather than `Date` rollover, and count Unicode code points with `[...value].length`.
- [ ] **Step 4: Run** `npm test -- src/domain/validation.test.ts`, `npm run typecheck`, and `npm run lint`; all must pass.
- [ ] **Step 5: Review** for unsafe HTML paths, optional-field ambiguity, and public interface consistency; fix all findings.
- [ ] **Step 6: Commit** `chore: scaffold typed travel map app`.

### Task 2: Offline city data pipeline and index

**Files:**
- Create: `scripts/build-city-data.mjs`, `src/cities/city-index.ts`, `src/cities/city-index.test.ts`, `src/cities/sample-data.ts`
- Generated: `src/generated/cities.data.ts`

**Interfaces:**
- Consumes: `CitySummary` from Task 1.
- Produces: `createCityIndex(cities)`, with `search(query, limit)` and `nearest(lon, lat, limit)`.

- [ ] **Step 1: Write failing tests** proving Chinese-name priority, accent-insensitive aliases, empty-query behavior, homonym disambiguation data, antimeridian distance, and result limits.

```ts
expect(index.search('慕尼黑', 5)[0].name).toBe('München');
expect(index.search('sao paulo', 5)[0].name).toBe('São Paulo');
expect(index.nearest(179.9, 0, 1)[0].id).toBe(nearDateline.id);
```

- [ ] **Step 2: Verify RED** with `npm test -- src/cities/city-index.test.ts`.
- [ ] **Step 3: Implement** normalized prefix/substring ranking and a fixed-degree grid spatial index with Haversine final ranking.
- [ ] **Step 4: Implement the build script** to parse GeoNames `cities500`, select preferred `zh`/`zh-CN` aliases, map country/continent metadata, emit deterministic compact arrays, source timestamp, and CC BY attribution. Reject malformed rows and duplicate IDs.
- [ ] **Step 5: Run tests, typecheck, and a fixture build**; inspect generated counts and deterministic checksum.
- [ ] **Step 6: Self-review** memory use, normalization collisions, longitude wrapping, source attribution, and malformed input handling; fix findings.
- [ ] **Step 7: Commit** `feat: add offline multilingual city index`.

### Task 3: Storage, statistics, and versioned backups

**Files:**
- Create: `src/storage/trip-store.ts`, `src/storage/memory-store.ts`, `src/storage/backup.ts`
- Create: `src/storage/trip-store.test.ts`, `src/storage/backup.test.ts`, `src/storage/statistics.ts`, `src/storage/statistics.test.ts`

**Interfaces:**
- Consumes: domain types from Task 1.
- Produces: `TripRepository`, `createTripStore`, `parseBackup`, `exportBackup`, `mergeBackup`, `calculateStats`.

- [ ] **Step 1: Write failing tests** for CRUD, city-ID uniqueness, newer-`updatedAt` merge wins, boundary union, atomic replace, unknown schema rejection, prototype-pollution keys, size limits, and continent/country counts.
- [ ] **Step 2: Verify RED** with `npm test -- src/storage`.
- [ ] **Step 3: Implement an in-memory adapter first**, then IndexedDB adapter with stores `visits`, `boundaries`, and `meta`, schema version 1, transactional import, and a surfaced persistence state.
- [ ] **Step 4: Implement strict backup parsing** without spreading untrusted objects; reconstruct whitelisted fields and validate geometry through the shared validator hook.
- [ ] **Step 5: Run storage tests and typecheck.** Simulate quota failure and verify fallback state is reported rather than silently accepted.
- [ ] **Step 6: Self-review** transaction boundaries, downgrade behavior, conflict rules, and data-loss paths; fix findings.
- [ ] **Step 7: Commit** `feat: add local trip storage and backups`.

### Task 4: SVG map and projection engine

**Files:**
- Create: `src/map/projection.ts`, `src/map/projection.test.ts`, `src/map/map-engine.ts`, `src/map/map-engine.test.ts`, `src/map/geometry.ts`, `src/map/geometry.test.ts`
- Create: `src/generated/world-map.ts`, `scripts/build-world-map.mjs`

**Interfaces:**
- Consumes: `CitySummary`, `CachedBoundary`.
- Produces: `project`, `unproject`, `normalizeAntimeridian`, `validateGeometry`, `createMapEngine`.

- [ ] **Step 1: Write failing tests** for projection round trips, latitude clamps, antimeridian polygons, invalid coordinates, unsupported geometry, excessive vertices, pan limits, and zoom anchoring.
- [ ] **Step 2: Verify RED** with `npm test -- src/map`.
- [ ] **Step 3: Implement pure geometry and projection helpers**, using Web Mercator latitude clamp ±85.05112878 and explicit antimeridian segment splitting.
- [ ] **Step 4: Implement the SVG engine** with country paths, sparse labels, wheel/pinch zoom, drag pan, keyboard zoom, visited polygons, fallback points, focus state, and reduced-motion handling.
- [ ] **Step 5: Implement Natural Earth conversion** to deterministic simplified SVG path data with public-domain attribution metadata.
- [ ] **Step 6: Run tests/typecheck and render fixture snapshots at desktop and 360px.**
- [ ] **Step 7: Self-review** event cleanup, pointer cancellation, label density, malicious path prevention, and transform precision; fix findings.
- [ ] **Step 8: Commit** `feat: add interactive svg world map`.

### Task 5: Boundary provider, throttling, and cache flow

**Files:**
- Create: `src/boundaries/provider.ts`, `src/boundaries/nominatim-provider.ts`, `src/boundaries/queue.ts`, `src/boundaries/boundary-service.ts`
- Create: `src/boundaries/queue.test.ts`, `src/boundaries/boundary-service.test.ts`

**Interfaces:**
- Consumes: city types, geometry validator, repository boundary methods.
- Produces: `BoundaryProvider`, `BoundaryService.fetchForCity(city, signal)`, status union `cached|fetched|unavailable|error`.

- [ ] **Step 1: Write failing tests** for cache-first behavior, one-second serialization, abort, 8-second timeout, HTTP 429, CORS/network failure, country mismatch, malformed/oversized GeoJSON, and no automatic retry.
- [ ] **Step 2: Verify RED** with `npm test -- src/boundaries`.
- [ ] **Step 3: Implement injectable clock/fetch provider**, URL built with `format=jsonv2&polygon_geojson=1&limit=5`, deliberate candidate matching, and OSM attribution.
- [ ] **Step 4: Implement cache-first orchestration**; only explicit user retry can enqueue after failure.
- [ ] **Step 5: Run tests and typecheck.** Assert no test makes a real network request.
- [ ] **Step 6: Self-review** policy compliance, privacy disclosure, URL encoding, response caps, stale cache, and cancellation; fix findings.
- [ ] **Step 7: Commit** `feat: fetch and cache city boundaries safely`.

### Task 6: Responsive travel-journal UI

**Files:**
- Create: `src/ui/app.ts`, `src/ui/search-panel.ts`, `src/ui/visit-editor.ts`, `src/ui/import-dialog.ts`, `src/ui/toast.ts`, `src/ui/app.test.ts`
- Modify: `src/main.ts`, `src/styles.css`, `index.html`

**Interfaces:**
- Consumes all core interfaces from Tasks 1–5.
- Produces the end-user application shell and semantic DOM contract used by E2E.

- [ ] **Step 1: Write failing DOM tests** for empty state, local search, nearby confirmation, immediate fallback point, boundary status, fuzzy date edit, note limit, delete/undo, title persistence, import merge/replace confirmation, and storage-degraded warning.
- [ ] **Step 2: Verify RED** with `npm test -- src/ui/app.test.ts`.
- [ ] **Step 3: Implement semantic UI** using safe `textContent`, event delegation, desktop collapsible journal rail, mobile bottom sheet, keyboard focus restoration, and actionable Chinese errors.
- [ ] **Step 4: Implement the visual system**: paper `#F8F2E7`, ocean `#DDE9E7`, ink `#304A49`, coral `#EA765F`, mustard `#D5A54A`, muted `#7F908B`; characterful Chinese title with system-safe fallback; route-thread dashed detail as the single signature motif.
- [ ] **Step 5: Run UI tests, typecheck, lint, and axe checks.** Capture desktop/mobile screenshots and critique density, hierarchy, focus, and reduced motion; fix findings.
- [ ] **Step 6: Commit** `feat: build responsive travel journal interface`.

### Task 7: Poster export and single-file production build

**Files:**
- Create: `src/export/poster.ts`, `src/export/poster.test.ts`, `scripts/inline-build.mjs`, `scripts/verify-single-file.mjs`
- Modify: `package.json`, `vite.config.ts`, `src/ui/app.ts`

**Interfaces:**
- Consumes map snapshot, statistics, title, cached boundaries.
- Produces `exportPoster('landscape'|'square')` and `dist/travel-map.html`.

- [ ] **Step 1: Write failing tests** for 1600×1000 landscape, 1200×1200 square, empty map, long-title truncation, no notes/controls in output, URL revocation, and image load failure.
- [ ] **Step 2: Verify RED** with `npm test -- src/export`.
- [ ] **Step 3: Implement deterministic SVG poster composition** and Blob-to-PNG conversion with explicit cleanup and Chinese error messages.
- [ ] **Step 4: Implement the inliner** to replace local scripts/styles/data/worker assets, reject remaining relative asset URLs, and emit exactly one HTML file.
- [ ] **Step 5: Run unit tests, production build, and** `node scripts/verify-single-file.mjs dist/travel-map.html`; assert file exists, is non-empty, under 35 MB, and has no required local assets.
- [ ] **Step 6: Self-review** Canvas taint, object URL leaks, CSP compatibility, file URL behavior, and oversized output; fix findings.
- [ ] **Step 7: Commit** `feat: export posters and self-contained html`.

### Task 8: Integration, two E2E rounds, deployment

**Files:**
- Create: `tests/e2e/happy-path.spec.ts`, `tests/e2e/resilience.spec.ts`, `.github/workflows/pages.yml`, `LICENSES.md`
- Modify: `README.md`, `package.json`
- Deliver: `outputs/travel-map.html`, `outputs/travel-map-preview.png`

**Interfaces:**
- Consumes the complete application.
- Produces tested release artifact and GitHub Pages deployment.

- [ ] **Step 1: Write E2E round-one tests** for search, map click candidates, add/edit/delete/undo, refresh persistence, boundary cache, JSON export/import both modes, and both poster layouts.
- [ ] **Step 2: Write E2E round-two tests** for offline boundary fallback, timeout/429/malformed geometry, same-name cities, invalid backup, empty export, 360px layout, keyboard-only use, and reduced motion.
- [ ] **Step 3: Run both rounds against port 4179.** For every failure, add or retain a failing regression test before fixing; rerun the affected suite and then both full rounds.
- [ ] **Step 4: Run release gate:** `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, both E2E rounds, artifact verifier, and `git diff --check`.
- [ ] **Step 5: Copy only final HTML and preview PNG to session `outputs/`, verify both exist and are non-empty.**
- [ ] **Step 6: Commit** `release: ship travel footprint map v1`, push feature branch, fast-forward/merge to `main`, push `main`, and verify remote SHA.
- [ ] **Step 7: Enable GitHub Pages via Actions**, wait for terminal deployment status, then run online smoke checks for HTTP 200, title, city search, and static asset independence.

