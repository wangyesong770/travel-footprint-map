# Global Country Boundary Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and independently verify an evidence-backed city-equivalent boundary package for every sovereign country in the approved registry.

**Architecture:** Auditors work from the same immutable Overture release and shared tooling but own disjoint country configuration/report files. A generated audit queue prevents omissions; regional batches may run in parallel, while one final cross-country gate checks sovereignty, identity, performance, and release consistency.

**Tech Stack:** JSON registries, Overture GeoParquet, DuckDB, Node.js audit CLI, TopoJSON, Vitest, authoritative national statistical/administrative sources.

## Global Constraints

- Requires every task in `2026-08-16-global-audit-infrastructure.md`.
- All extraction, selectors, packages, reports, and review evidence in this plan use exact release `2026-06-17.0` / schema `v1.17.0`.
- The country set is generated from `data-audit/sovereign-registry.json`; no hard-coded “about 195” completion claim is accepted.
- CN includes source codes CN/HK/MO/TW and uses `china-official`; there are no separate world entries for HK, MO, or TW.
- Other territories appear under exactly one reviewed sovereign country while retaining source codes.
- Official source citations must be direct HTTPS links with capture dates and license/use notes.
- An auditor may set `failed`, never weaken a global threshold merely to obtain `verified`.
- Every country task follows RED → GREEN → self-review → focused verification → commit.

---

### Task 1: Sovereign ownership registry and audit queue

**Files:**
- Modify: `data-audit/sovereign-registry.json`
- Create: `scripts/audit/list-audit-queue.mjs`
- Create: `scripts/audit/list-audit-queue.test.mjs`
- Create: `data-audit/references/README.md`

**Interfaces:**
- Produces one owner for every Overture source country code and `npm run audit:queue -- --release 2026-06-17.0`.
- Queue rows are `{ sovereignCode, sourceCountryCodes, perspective, configStatus, reportStatus }` sorted by sovereign code.

- [ ] **Step 1: Write failing tests** for source code without owner, two sovereign owners, independent HK/MO/TW entries, empty world geometry mapping, non-sovereign world entry, and stable sorted queue output.
- [ ] **Step 2: Run** `npm test -- scripts/audit/list-audit-queue.test.mjs`; expect RED because the queue tool is absent.
- [ ] **Step 3: Complete the registry** from the approved China-official sovereign baseline and reconcile every entry with the checked-in Natural Earth world layer. Record `sourceCountryCodes`, visible Chinese/local names, continent-by-location metadata, and perspective.
- [ ] **Step 4: Implement queue generation** using exact set comparison across registry, selectors, reports, world polygons, and packages. Never infer ownership by spatial containment.
- [ ] **Step 5: Run** `npm run audit:queue -- --release 2026-06-17.0` and require zero ownership/world-map errors; non-verified rows remain visible.
- [ ] **Step 6: Self-review** disputed territories, overseas departments, transcontinental statistics, duplicate display names, and any politically inferred mapping; fix findings with evidence.
- [ ] **Step 7: Commit** `data: define sovereign ownership audit queue`.

### Task 2: Country selector authoring contract

**Files:**
- Create: `data-audit/selectors/_template.json`
- Create: `data-audit/exceptions/_template.json`
- Create: `scripts/audit/verify-selector-evidence.mjs`
- Create: `scripts/audit/verify-selector-evidence.test.mjs`

**Interfaces:**
- Each selector declares raw Overture predicates, internal product level, expected-count rule, reference IDs, sample IDs, allowlist, and denylist.
- Produces `npm run audit:selector -- --country CN --release 2026-06-17.0` and accepts any code present in the sovereign registry.

- [ ] **Step 1: Write failing tests** for an absent official reference, unreachable reference metadata, selector with no positive predicate, undocumented allowlist/denylist ID, sample outside final result, and a complete fixture.
- [ ] **Step 2: Run** `npm test -- scripts/audit/verify-selector-evidence.test.mjs`; expect RED.
- [ ] **Step 3: Implement the template and verifier.** Require reference title, publisher, direct URL, captured date, effective date, license/use note, and whether the source is machine-readable.
- [ ] **Step 4: Require explicit sampling.** Each country records capital-equivalent, ordinary urban, small/rural, border/coastal where applicable, and every special-case class; each sample binds to a `divisionId` and expected inclusion.
- [ ] **Step 5: Run fixture extraction and selector verification** and prove an unexplained count mismatch produces `failed`, not warning-only output.
- [ ] **Step 6: Self-review** source authority, time mismatch, sample cherry-picking, exception documentation, and local-vs-product terminology; fix findings.
- [ ] **Step 7: Commit** `test: enforce country selector evidence contract`.

### Task 3: Regional audit batches

**Files:**
- Create/Modify: one `data-audit/selectors/{sovereignCode}.json` per audit-queue row
- Create/Modify: one `data-audit/exceptions/{sovereignCode}.json` per audit-queue row
- Generate: one `data-audit/reports/2026-06-17.0/{sovereignCode}.json` per audit-queue row
- Generate: one `public/data/countries/{sovereignCode}.topojson` per audit-queue row

**Interfaces:**
- Consumes the queue from Task 1 and the verifier from Task 2.
- Produces a `verified|failed` report for every registry country; only verified packages are candidates for the global gate.

- [ ] **Step 1: Snapshot the queue** and divide it by registry `auditRegion` into disjoint batches: `east-asia-pacific`, `south-central-asia`, `europe`, `middle-east-north-africa`, `sub-saharan-africa`, `north-america-caribbean`, and `latin-america`.
- [ ] **Step 2: For each queue row, first write a failing selector fixture test** containing at least one included and one excluded real `divisionId`; run `npm run audit:country -- --country "$COUNTRY_CODE" --release 2026-06-17.0` after assigning `COUNTRY_CODE` from that row, and confirm `SELECTOR_UNVERIFIED` or the intended QA failure.
- [ ] **Step 3: Add authoritative evidence and exact predicates** until the country command produces a report whose status is `verified`. Any unavailable or contradictory evidence leaves that country `failed` with its failure code.
- [ ] **Step 4: Inspect every required sample** against the official reference and generated geometry; record sample decisions and all allowlist/denylist reasons in the country report.
- [ ] **Step 5: Run each complete regional batch** with `npm run audit:region -- --region "$AUDIT_REGION" --release 2026-06-17.0`, where `AUDIT_REGION` is one of the seven exact values in Step 1; require exact registry coverage and zero `draft`, missing, or failed rows before accepting that batch.
- [ ] **Step 6: Self-review each batch** for a suspiciously uniform raw admin level, missing municipalities, sub-city districts, statistical areas, duplicate IDs, gaps forced closed, and unexplained large overlaps; fix findings.
- [ ] **Step 7: Commit each independently reviewed region** as `data: audit <auditRegion> city boundaries`; do not combine a failed region with a passing one.

### Task 4: China-official consolidated map audit

**Files:**
- Modify: `data-audit/sovereign-registry.json`
- Create: `data-audit/selectors/CN.json`
- Create: `data-audit/exceptions/CN.json`
- Create: `scripts/audit/china-perspective.test.mjs`
- Generate: `data-audit/reports/2026-06-17.0/CN.json`
- Generate: `public/data/countries/CN.topojson`

**Interfaces:**
- Produces one CN world entry/package covering registered CN/HK/MO/TW sources under the approved China-official product view.

- [ ] **Step 1: Write failing tests** proving HK/MO/TW never appear in the world manifest, all four source-code groups resolve to sovereign `CN`, country statistics count them as China, and area statistics preserve their physical continent location.
- [ ] **Step 2: Run** `npm test -- scripts/audit/china-perspective.test.mjs`; expect RED against the old world/index assumptions.
- [ ] **Step 3: Author the CN selector and exceptions** from direct Chinese official administrative references, explicitly documenting the product-level treatment and any Overture field divergence for mainland, Hong Kong, Macau, and Taiwan.
- [ ] **Step 4: Generate the consolidated package** without renaming or re-keying upstream `divisionId`; expose one China navigation entry and preserve `sourceCountryCode` in evidence.
- [ ] **Step 5: Inspect required samples** from mainland municipalities/prefectures, Hong Kong, Macau, Taiwan, islands, enclaves, and cross-boundary edge cases; record exact IDs and decisions.
- [ ] **Step 6: Run** `npm run audit:country -- --country CN --release 2026-06-17.0` plus global sovereignty tests; require verified status and zero independent HK/MO/TW entries.
- [ ] **Step 7: Self-review** official naming, ownership mapping, duplicated geometries, product-level comparability, and user-visible statistics; fix findings.
- [ ] **Step 8: Commit** `data: audit consolidated China city boundaries`.

### Task 5: Cross-country identity and performance audit

**Files:**
- Create: `scripts/audit/verify-cross-country.mjs`
- Create: `scripts/audit/verify-cross-country.test.mjs`
- Generate: `data-audit/reports/2026-06-17.0/summary.json`

**Interfaces:**
- Produces exact global metrics and blocks duplicate ownership, duplicate area IDs, missing index IDs, mixed releases, and performance budget failures.

- [ ] **Step 1: Write failing tests** for the same source code in two sovereign packages, duplicate `divisionId`, missing index record, package/index name disagreement, mixed release, one >20 MiB country, and valid complete fixture.
- [ ] **Step 2: Run** `npm test -- scripts/audit/verify-cross-country.test.mjs`; expect RED.
- [ ] **Step 3: Implement streaming cross-country checks** so package bytes and IDs are processed one country at a time; retain only hash sets and aggregate metrics rather than all geometries.
- [ ] **Step 4: Benchmark representative large/medium/small packages** in Chromium-compatible parsing code and record compressed size, parse p50/p95, render path count, global index bytes, and peak process RSS in summary evidence.
- [ ] **Step 5: Run** `npm run audit:global -- --release 2026-06-17.0` and require exact queue/selector/report/package equality, all statuses verified, and all budgets passing.
- [ ] **Step 6: Self-review** hash memory growth, unreviewed exception counts, hidden failed rows, stale generated index, and summary/report checksum consistency; fix findings.
- [ ] **Step 7: Commit** `data: complete global sovereign boundary audit`.

### Task 6: Independent global audit review

**Files:**
- Create: `docs/global-audit-review-2026-06-17.0.md`
- Modify only when findings require fixes: relevant `data-audit/**`, tests, and generated country artifacts

**Interfaces:**
- Produces a reviewer-signed checklist with every automated gate command, result, finding, fix commit, and final release-ready checksum.

- [ ] **Step 1: A reviewer not responsible for the country batch re-runs** the queue, each regional gate, CN perspective test, cross-country audit, license audit, and global gate from a clean checkout.
- [ ] **Step 2: Sample at least one ordinary and one exceptional area from every country report** using the report’s bound IDs; record mismatches as blocking findings.
- [ ] **Step 3: For each finding, add a failing regression test or evidence assertion**, repair selector/config/code, regenerate affected reports and packages, and rerun the affected region plus the global gate.
- [ ] **Step 4: Run the full clean gate** `npm ci && npm run lint && npm run typecheck && npm test && npm run audit:global -- --release 2026-06-17.0 && npm run build && git diff --check`.
- [ ] **Step 5: Record exact command outputs, commit SHA, Overture release, summary checksum, reviewer, review time, and zero unresolved blockers** in the review document.
- [ ] **Step 6: Commit** `audit: approve complete global boundary release`.
