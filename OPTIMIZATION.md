# Code review and optimization - working log

A review of the whole codebase (2026-11-12) by area - admin components and pages, admin composables and utils,
`apps/server`, `packages/*` - looking for bugs, duplication, misplaced logic (AGENTS.md §6), dead code and
inconsistent patterns. Each finding was checked in the code before it went on this list. Work happens on `main`, one
commit per change, each with its test; this file tracks what is done and what is left.

Status: **done** · **in progress** · **pending** · **skipped** (with why).

## Phase A - real bugs (done)

| # | Finding | Status | Commit |
|---|---|---|---|
| A1 | OpenAPI typed `bigint`/`numeric` as numbers; the Data API returns strings | done | `14a730d2` |
| A2 | File content fetched without the API headers: view-as read files with the administrator's grants | done | `6b686001` |
| A3 | A column input's CHECK left the column unquoted (`MyCol`, reserved words); config numbers unchecked | done | `82bd3986` |
| A4 | A PUT replacing a set (role managers/incompatible, column presentation) read a missing field as empty | done | `f26596a5` |
| A5 | A non-UUID id in the path answered PostgreSQL's 400 instead of 404 | done | `cfc198d6` |
| A6 | Resources browser: sidebar stale after drop/endpoints; an artificial 1.5 s wait | done | `933e681f` |
| A7 | Copy failed on plain HTTP (no `navigator.clipboard`) | done | `dfefcd2f` |
| A8 | Raw English API errors in view-as, the file editor, image preview, query records | done | `d3d1c5e7` |
| A9 | Bulk-delete partial messages borrowed other screens' keys | done | `c2528a12` |
| A10 | Dashboard spec apply judged a taken name case-insensitively, unlike its UNIQUE | done | `6bd5c2a7` |
| - | Four settings without admin labels (i18n coverage) | done | `e62ceca8` |

## Phase A+ - one table editor (done)

The Edit table drawer and the table page both edited a table's structure. Now the page is the only editor:

- A column's panel has a **Database** tab (name, type, nulls, default, UNIQUE, foreign key) with the SQL shown as it
  is edited; one **Save** runs the ALTERs and then the presentation in one transaction (`86142c27`, `2b5668f9`).
- **Primary key** and **Rename** show their SQL before **Apply**; `TableDrawer.vue` is gone (`4d24a9da`).
- Follow-ups from manual testing: aligned row actions (`9d2a5a25`), double click in Add column (`8f0f521b`), no dash
  for an empty suggestion (`764a5541`), icon tabs in the column panel (`6e48f33c`).

## Phase B - performance (done)

| # | Finding | Effort | Status |
|---|---|---|---|
| B1 | Caller roles resolved again and again per request (8-20 extra queries on `GET /app/api/dataviews/:slug`); memoize per request | S-M | done |
| B2 | Versions/snapshots written row by row (dashboards restore/duplicate/spec apply, DataView versions, app menu); one `INSERT ... FROM jsonb_to_recordset` | M | done |
| B3 | Workflows-role guard: 2 SELECTs per role duplicating a trigger, N single INSERTs (also AGENTS.md §16) | S | done |
| B4 | App record catalogs resolve READ/CREATE/UPDATE separately and load password columns twice | S | done |
| B5 | Role delegation N+1 (`app-roles.ts` bulk PUT and `/objects`, copy permissions) | S-M | done |

## Phase C - reuse in the admin (done)

| # | Finding | Effort | Status |
|---|---|---|---|
| C1 | Delete confirmation modal hand-written ~25 times in two markups; one `DeleteConfirmModal` + `useBulkDelete` | M | done |
| C2 | Versions flow copied in DataViews and Dashboards; one `useObjectVersions` (`useWorkflowVersions` builds on it) | M | done |
| C3 | Table / View / Function detail pages share ~100 lines each (endpoints, danger zone, description) - one shell and shared sections in `resource-detail/` | M | done |
| C4 | Kanban, Gantt and lane order copy the same lane fetch and ordering - `useLaneRows` + `orderLanes` | S | done |
| C5 | Small duplicates: blob download (8), CSV, two `slugify`, backend constants mirrored by hand, roles fetched under two keys | S | done |
| C6 | `useDataApi` repeats `useAdminApi`'s client logic - it builds on `createSessionApi` | S | done |

## Phase D - large files with a natural split (pending)

`files.vue` (1472), `DataViewGrid.vue` (1671), `WidgetRenderer.vue` (1213), `UserAdminEditor.vue` (1080),
`dashboard-builders.ts` (1596), `types/dataview.ts` (1416, runtime resolvers in a types file). One at a time, when the
area is touched.

## Phase E - architecture boundaries (done)

| # | Finding | Effort |
|---|---|---|
| E1 | Domain logic in server routes: delegated-grant ceiling (twice), DataView access (imported by 5 routes), user invitation, raw SQL in ~10 routes - to `@totalbase/permissions`, `dataviews`, `mutations` - done (`beyondCeiling`, `ceilingOf`, object access; `dataviews-viewer.ts`, `columnReference`; `inviteUser`; `activeResourceByName`). Left: `/admin/api/system`'s one version read | L |
| E2 | Catalog introspection scattered outside `@totalbase/pg-catalog` (~20 queries) - done for the copied reads: `listAttributes`, `singleColumnPrimaryKey`, `findConstraintName` (13 sites) | M-L |
| E3 | Identifier/literal quoting copied 7 and 4 times; one home in `@totalbase/shared` - done: `quoteIdentifier`/`quoteLiteral`, re-exported by `@totalbase/database` | S-M |
| E4 | Request bodies read by hand in ~66 handlers instead of `requestData` (done - `requestData`/`optionalData`; auth routes and Data API payloads keep theirs, by AGENTS.md §14B); seven pagination parsers (one `pageOf` - done; audit and backups keep their documented own); 13 hand-built audit entries (`adminAuditEntry` - done) | S each |
| E5 | Publish answers differently for DataViews/Dashboards (201) and Workflows (200) - decided (2026-11-12): all three answer the version, `201` created / `200` nothing to publish; the admin and the MCP tools say so - done | S-M |

## Reviewed and not changed

- The workflow filter evaluator runs in JavaScript - documented on purpose (`Workflows.md` §5.9: plain JSON, no table).
- `optionalFilterSql` writes a suggestion into the administrator's own widget SQL editor - not the admin building SQL.
- Clean: only `@totalbase/database` imports `pg`, no deep cross-package imports, one pool, no dead components.
- E2's other `pg_*` reads stay where they are: joins of TotalBase's own tables with `pg_attribute` (a stored attnum to
  its name, a view column's origin - domain queries, not introspection), activity and progress views (`pg_stat_*`,
  replication slots), the migration runner's own bootstrap, and the dashboard suggester's and runner's analysis of a
  widget's SQL (statistics, partition roots, Row Level Security) - each one of a kind.

## Release checks (2026-11-12)

- `scripts/test-matrix.sh all`: PostgreSQL 15, 16 and 17 passed; 18 the same except the built-in backups' 4 tests -
  this machine's `pg_dump` is 17 and refuses an 18 server (as in UPGRADE.md; the image carries 18's). The six
  `@totalbase/resources` tests that failed on the local test database pass on the matrix's fresh ones.
- `scripts/test-e2e.sh`: 194 passed, 1 skipped and 1 failed on the last full run - that one fixed and its file rerun (22 passed) - after the specs followed what this work changed on purpose - the
  shared version toasts, Edit column, Save closing a file's details, the Danger zone's not-owned note.
