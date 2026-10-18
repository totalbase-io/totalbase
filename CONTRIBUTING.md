# Contributing to TotalBase

Thanks for helping. This file has what a contribution needs: how to run the project, the rules every change follows, and how a pull request is accepted.

## Before you start

- **Open an issue first** for anything beyond a small fix, and say what you plan to change. TotalBase keeps a deliberately narrow scope, and an agreement before the code saves you work.
- **Sign the [Contributor License Agreement](CLA.md).** The CLA Assistant asks for it on your first pull request; one click, once.
- **Security problems** never go in a public issue: see [SECURITY.md](SECURITY.md).

## Running it

You need Node.js 22, pnpm 10 and a reachable PostgreSQL 15-18 with a role that owns a database.

```bash
pnpm install
cp .env.example .env        # the connection, a master key, the first administrator
pnpm dev                    # server and admin on one origin: http://localhost:3050/admin/
```

`pnpm dev` runs the API server and the admin's dev server together; open only the URL it prints. Its migrations run on start, in the `totalbase` schema.

### Tests

```bash
pnpm -r run build
TOTALBASE_TEST_DB=totalbase_test pnpm test:integration    # every package, against its own database
```

Integration tests run against **real PostgreSQL**, in a database of their own - never the one `pnpm dev` uses: they create and drop tables. Files run one at a time (`fileParallelism: false`); don't turn that off. End-to-end tests (Playwright, `e2e/`) run against `pnpm dev` with one worker.

## The rules

### PostgreSQL is the authority

Whenever PostgreSQL already defines something - constraints, types, transactions, defaults, foreign keys, uniqueness, checks, triggers, functions, errors - TotalBase uses PostgreSQL's behavior instead of reimplementing it in application code.

- Don't pre-check what a constraint enforces (a `SELECT` before an insert to "check" uniqueness): let PostgreSQL decide, atomically, and map its error.
- Relations come from real foreign keys; there is no virtual relation metadata.
- Keep PostgreSQL's own error messages - a `RAISE EXCEPTION` is the rule's own text - unless security requires hiding them.

### PostgreSQL versions and privileges

- Supported: PostgreSQL **15, 16, 17 and 18**. Don't rely on anything newer than 15 without a version check; CI runs every version.
- **Never require `SUPERUSER`.** The configured role's privileges are the ceiling of what TotalBase can do, and nothing escalates them.

### SQL

- Clients never send SQL to the Data API. A request goes parser → AST → catalog validation → permissions → SQL compiler → **parameterized** SQL.
- Values are always parameters. Identifiers come from catalog metadata and are quoted centrally. Never concatenate a user-supplied identifier or value into SQL.
- The exceptions are explicit and administrator-only: the SQL Console, and dashboard widget queries (read-only transaction, row cap, bound variables).
- One filter grammar (`{ "field": { "_op": value } }`) serves request filters, row filters and payload checks. Extend it; never add a second one.

### Permissions

The semantics are fixed: **DENY > ALLOW > undefined** for actions and fields; row filters from several grants combine with **OR**, and with a request's own filter with **AND**; an UPDATE is authorized against the row **before and after**. Every security bug fixed gets a permanent regression test.

### Packages

The monorepo has strict boundaries. Only `@totalbase/database` imports `pg`; the query engine owns parsing and SQL compilation; `@totalbase/permissions` owns permission resolution, used the same way by every reader. Import a package through its public `index.ts`, never a deep path. `apps/server` stays thin: routes, HTTP and lifecycle, no domain logic.

### Migrations

TotalBase's own schema changes only through a new file in `migrations/totalbase/`, after the existing ones. A published migration is never edited: installed databases already hold it. `totalbase.users` may carry an installation's own columns; a migration must keep them.

### API conventions

- Every JSON body, both ways, carries its content in `data`; errors come in `errors`. `201` for a create, `204` when there's nothing to return, `404` for an unknown id anywhere in the path.
- Keys TotalBase defines are **camelCase**; PostgreSQL column names keep their own.
- Use `TotalBaseError` with a stable error code; never expose generated SQL from the Data API.

### Admin UI

- Built with [Nuxt UI](https://ui.nuxt.com), as it comes: no per-screen restyling. A change of look goes in `apps/admin/app/app.config.ts`, once, for every instance.
- Every page renders in `PageShell`; tables are `UTable`; forms put help under a field (`description`), not in a placeholder.
- It works on a phone, a tablet and a desktop: check all three.
- Every text goes through i18n, in English and in neutral Spanish.

### Code

- TypeScript, English for every identifier and comment. `PascalCase` types, `camelCase` functions and variables, `SCREAMING_SNAKE_CASE` constants, `kebab-case` files. No `I`/`T` prefixes.
- Comments say why, not what. Match the density of the code around you.
- Logs through Pino; never log a secret.
- New dependencies need a reason: say in the pull request why Node or PostgreSQL don't already solve it.

### Documentation

The user documentation is published on its own, outside this repository. When a pull request changes what users see - a screen, a label, a setting, a route, an error code - say so in its description, with the new behavior, so the documentation can follow in the same release.

## Pull requests

- One purpose per pull request; keep refactors apart from features.
- [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, with a scope when it helps (`fix(data-api): …`).
- Lint, typecheck and the tests of what you changed pass: `pnpm lint`, `pnpm typecheck`, and the package's tests.
- Describe what changed and why, and how you checked it. Screenshots for UI changes, on a phone too when the layout changes.

A maintainer reviews it. The public repository receives each release as one snapshot, so an accepted pull request is applied to the development repository by hand and appears in the next release, with your authorship credited in its notes.
