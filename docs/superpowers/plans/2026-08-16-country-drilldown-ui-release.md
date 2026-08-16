# Country Drilldown UI and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace point-first map interaction with an accessible world→country→area drilldown, adapt search/editor/posters, and deploy only after two complete E2E rounds.

**Architecture:** A route-like view model owns `world` and `country` states. The SVG engine renders interactive country paths at world level and validated administrative features at country level; the UI composes the package service and V2 repository, while poster generation consumes pure snapshots.

**Tech Stack:** TypeScript 6, SVG, Vite 8, Vitest 4, Testing Library, Playwright 1, IndexedDB.

## Global Constraints

- Requires completed contracts from the country-boundary and area-storage plans.
- The world layer never uses city points; a country click navigates and never creates a visit.
- An unvisited area click immediately creates a coral visit and opens its editor.
- A visited area click only opens the editor; removal requires a distinct button and offers undo.
- Desktop and 360px mobile layouts, keyboard navigation, visible focus and reduced motion are release gates.
- The existing production version remains live until the complete replacement passes all gates.
- Never use, kill or restart `127.0.0.1:8080`; local tests use another free port.

---

### Task 1: Drilldown view model

**Files:**
- Create: `src/navigation/map-view-model.ts`
- Create: `src/navigation/map-view-model.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Produces `MapLevel = {kind:'world'} | {kind:'country'; countryCode:string; focusedAreaId?:AreaId}` and pure actions `enterCountry`, `focusArea`, `returnToWorld`, `restoreView`.

- [ ] **Step 1: Write failing tests** for initial world state, valid country entry, lowercase normalization, invalid code rejection, city-search deep link, back-to-world, stale focused ID removal and serializable restoration.
- [ ] **Step 2: Run** `npm test -- src/navigation/map-view-model.test.ts` and confirm RED.
- [ ] **Step 3: Implement the pure state reducer.** A country must exist in the manifest before entry; a focused area must belong to the active country.
- [ ] **Step 4: Run verification.** Execute `npm test -- src/navigation/map-view-model.test.ts && npm run typecheck`; both commands must pass.
- [ ] **Step 5: Self-review** impossible states, browser-back expectations, stale manifest behavior and country/area mismatch; fix findings.
- [ ] **Step 6: Commit** `feat: add world country map navigation state`.

### Task 2: Interactive world and country SVG engine

**Files:**
- Modify: `src/map/map-engine.ts`
- Modify: `src/map/map-engine.test.ts`
- Create: `src/map/country-layer.ts`
- Create: `src/map/country-layer.test.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Produces `MapEngine.showWorld(summary)`, `MapEngine.showCountry(package, visits)`, `MapEngine.focusArea(areaId)`, callbacks `onCountrySelect(code)` and `onAreaSelect(areaId)`.
- Consumes only validated packages.

- [ ] **Step 1: Write failing DOM tests** for country click callback, keyboard Enter/Space, visited-country summary class/count, country fit-to-bounds, all package features rendered, unvisited/visited classes, area click identity, visited re-click identity, focus restoration, tiny-area transparent hit path, pan-vs-click suppression and destroy cleanup.

```ts
expect(svg.querySelector('[data-area-id="CN:osm:beijing"]')).toHaveClass('area-visited');
fireEvent.click(svg.querySelector('[data-area-id="CN:osm:beijing"]')!);
expect(onAreaSelect).toHaveBeenCalledWith('CN:osm:beijing');
```

- [ ] **Step 2: Run** `npm test -- src/map/map-engine.test.ts src/map/country-layer.test.ts` and confirm RED.
- [ ] **Step 3: Split rendering responsibilities.** Keep projection/pan/zoom shared; world layer creates semantic country buttons; country layer converts validated MultiPolygon topology to safe SVG paths and labels only the active/focused area.
- [ ] **Step 4: Implement zoom-to-country bounds** with fixed padding, clamped scale and antimeridian-aware bounds. Do not alter geographic geometry to create the larger hit target.
- [ ] **Step 5: Add coral visual states**: unvisited paper fill, hover/focus wash, visited `#EA765F`, stale-cache indicator outside the path, and high-contrast focus ring.
- [ ] **Step 6: Run verification.** Execute `npm test -- src/map && npm run typecheck && npm run lint`; all commands, including the reduced-motion cases in `map-engine.test.ts`, must pass.
- [ ] **Step 7: Self-review** DOM count, event delegation, XSS through names, path size, focus order, pointer cancellation, mobile hit targets and transform precision; fix findings.
- [ ] **Step 8: Commit** `feat: render clickable country city boundaries`.

### Task 3: Area-aware global search

**Files:**
- Create: `src/areas/area-index.ts`
- Create: `src/areas/area-index.test.ts`
- Modify: `scripts/build-country-boundaries.mjs`
- Generate: `src/generated/area-index.data.ts`
- Modify: `src/app-wiring.ts`

**Interfaces:**
- Produces `createAreaIndex(records).search(query, limit)` where records contain no geometry and return exact `areaId` plus `countryCode`.

- [ ] **Step 1: Write failing tests** for Chinese priority, local-name and alias match, accent folding, same-name country/admin disambiguation, country results before substring results, empty query, result limit and exact ID parity with package fixtures.
- [ ] **Step 2: Run** `npm test -- src/areas/area-index.test.ts` and confirm RED.
- [ ] **Step 3: Extend the build pipeline** to emit one compact geometry-free global index from the same normalized feature records. Fail the build when an index ID is absent from its country package or duplicated.
- [ ] **Step 4: Implement normalized exact/prefix/substring ranking** without network autocomplete. A city result includes `kind:'area'`; a country result includes `kind:'country'`.
- [ ] **Step 5: Run verification.** Execute `npm test -- src/areas/area-index.test.ts`, run the fixture builder twice into separate temporary directories and compare with `cmp`, then execute `npm run typecheck && npm run lint`; all checks must pass.
- [ ] **Step 6: Self-review** memory budget, name collision, script-breaking source strings, Chinese alias loss and stale index/package version mismatch; fix findings.
- [ ] **Step 7: Commit** `feat: search administrative areas by stable id`.

### Task 4: Responsive application integration

**Files:**
- Modify: `src/ui/app.ts`
- Modify: `src/ui/app.test.ts`
- Modify: `src/app-wiring.ts`
- Modify: `src/app-wiring.test.ts`
- Modify: `src/styles.css`
- Remove after migration: `src/boundaries/nominatim-provider.ts`, `src/boundaries/boundary-service.ts`, `src/boundaries/queue.ts` and their tests

**Interfaces:**
- Consumes `MapLevel`, `CountryPackageService`, area index, V2 repository and drilldown map engine.
- Produces the complete semantic UI contract used by E2E.

- [ ] **Step 1: Write failing UI tests** for country entry, loading skeleton, cached success, stale-cache warning, no-cache failure/retry, breadcrumb return, city-search deep link, immediate area visit, editor opening, visited re-click without removal, explicit removal/undo, auto-save date/note, country completion stats, mobile drawer behavior and cache management.
- [ ] **Step 2: Run** `npm test -- src/ui/app.test.ts src/app-wiring.test.ts` and confirm RED.
- [ ] **Step 3: Refactor the shell around map level.** World title and global stats remain; country state shows breadcrumb, scheme label, package status and country stats. Remove nearby-city coordinate candidates and boundary-fetch status UI.
- [ ] **Step 4: Implement area selection.** On an unvisited click, persist `VisitV2` before coral rendering, then open editor. On persistence failure, revert visual state and show an actionable export/storage message.
- [ ] **Step 5: Implement visited selection and removal.** Re-click only selects; removal is a labeled destructive button with confirm state and undo transaction.
- [ ] **Step 6: Implement responsive layout.** Desktop keeps collapsible side journal; mobile bottom drawer opens for editor and leaves breadcrumb/zoom controls reachable. Ensure focus moves to editor heading and returns to the selected area on close.
- [ ] **Step 7: Remove obsolete Nominatim flow** only after no production imports reference it; retain required historical attribution in documentation, not runtime UI.
- [ ] **Step 8: Run verification.** Execute `npm test -- src/ui src/map src/storage src/app-wiring.test.ts && npm run typecheck && npm run lint`; all commands, including the 360px cases in `app.test.ts`, must pass.
- [ ] **Step 9: Self-review** race between rapid country switches, click-before-save, stale package update, cancellation, screen-reader announcements, drawer obstruction and accidental deletion; fix findings.
- [ ] **Step 10: Commit** `feat: replace point search with country drilldown flow`.

### Task 5: World and country poster export

**Files:**
- Modify: `src/export/poster.ts`
- Modify: `src/export/poster.test.ts`
- Modify: `src/ui/app.ts`

**Interfaces:**
- Produces `exportPoster({ scope:'world' } | { scope:'country'; countryCode:string }, layout, snapshot)`.

- [ ] **Step 1: Write failing tests** for 1600×1000 and 1200×1200, world visited-country summary, country all-boundary drawing, coral visited areas, missing-package rejection, long/unsafe title, no notes, no controls, object-URL cleanup and Canvas failure.
- [ ] **Step 2: Run** `npm test -- src/export/poster.test.ts` and confirm RED.
- [ ] **Step 3: Refactor pure SVG composition** to accept validated country packages and area visits. World scope never implies a country visit; country scope includes scheme label and source attribution.
- [ ] **Step 4: Add UI scope choice** with default based on current map level; disable country export with an explicit load message when no valid package is available.
- [ ] **Step 5: Run verification.** Execute `npm test -- src/export src/ui && npm run typecheck && npm run lint`; all commands must pass.
- [ ] **Step 6: Self-review** private-note leakage, huge SVG memory, XML escaping, platform fonts, URL revocation and fixed output dimensions; fix findings.
- [ ] **Step 7: Commit** `feat: export world and country area posters`.

### Task 6: Build packaging and two-round E2E

**Files:**
- Modify: `scripts/inline-build.mjs`
- Modify: `scripts/inline-build.test.mjs`
- Create: `tests/e2e/country-drilldown.spec.ts`
- Create: `tests/e2e/country-resilience.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

**Interfaces:**
- Produces self-contained application shell plus external `/data/countries/*` packages, and deterministic browser test evidence.

- [ ] **Step 1: Write failing build tests** proving JS/CSS/global area index are inlined, country packages remain same-origin external assets, no dev URL remains, and manifest/package paths resolve beneath the deployment base.
- [ ] **Step 2: Write E2E round one** covering world→China, boundary load, Beijing immediate point-light, editor date/note, re-click edit only, remove/undo, reload cache, city-search deep link, global and country posters, V2 export and merge import.
- [ ] **Step 3: Write E2E round two** at 360px covering drawer collapse, rapid China→Japan cancellation, offline cached country, offline uncached country, 404, 429, timeout, checksum mismatch, malformed geometry, IndexedDB quota failure, keyboard-only selection, reduced motion, V1 ambiguous migration and replace rollback.
- [ ] **Step 4: Run build tests and confirm RED** until base-path/package behavior is implemented.
- [ ] **Step 5: Update the inliner and Vite base configuration.** The HTML must not inline country packages; the manifest and packages must be copied to `dist/data/countries` and verified against checksums.
- [ ] **Step 6: Run round one on a free port other than 8080.** Every defect gets a focused failing regression test before repair; rerun the affected suite and the full round.
- [ ] **Step 7: Run round two on a fresh browser profile and deterministic network mocks.** Repair every defect with the same regression discipline, then rerun both rounds.
- [ ] **Step 8: Run direct `file://` shell smoke.** Confirm the app starts and explains that uncached country packages require a hosted same-origin deployment; do not claim a new country can load from file URLs.
- [ ] **Step 9: Commit** `test: verify country drilldown end to end`.

### Task 7: Release audit, deploy and rollback proof

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/visual-system.md`
- Create: `docs/release-country-drilldown.md`
- Deliver: session `outputs/travel-map.html`, `outputs/travel-map-preview.png`

**Interfaces:**
- Produces a versioned production release and a documented rollback target; no production mutation occurs until all gates pass.

- [ ] **Step 1: Run the release gate:** `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, boundary integrity verification, `npm run build`, both Playwright rounds and `git diff --check`.
- [ ] **Step 2: Audit the production artifact** for manifest/package 200 responses, MIME types, immutable hashed package caching, HTML no-cache policy, CSP compatibility, source attribution, no secrets, no localhost URLs and no reference to port 8080.
- [ ] **Step 3: Capture desktop and mobile screenshots** and inspect world hierarchy, country boundaries, coral contrast, tiny-region affordance, drawer obstruction, loading/error states and focus visibility. Fix defects, add regression coverage and rerun the release gate.
- [ ] **Step 4: Write release notes** with changed interaction model, administrative-level caveats, first-load network requirement, cache size, V1 migration and rollback procedure.
- [ ] **Step 5: Commit and push** using a normalized release commit; verify remote SHA and CI terminal success before deployment.
- [ ] **Step 6: Deploy to a new versioned static directory** on the approved host, validate its files and Nginx configuration, switch the application-path symlink atomically, and leave the prior version intact for rollback. Do not restart or signal the service on `127.0.0.1:8080`.
- [ ] **Step 7: Run online smoke checks** for world load, China package 200/checksum, country entry, area click persistence, reload, mobile layout and poster creation. On failure, atomically restore the prior static symlink and document the failed release.
- [ ] **Step 8: Copy only the final HTML and approved preview PNG** to session `outputs/`; verify both exist and are non-empty.
- [ ] **Step 9: Commit** `release: ship country drilldown travel map` if deployment documentation changed after the release commit.
