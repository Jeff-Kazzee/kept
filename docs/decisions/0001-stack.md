# 0001: Stack

Status: accepted, 2026-10-27

## Decision

- TypeScript in strict mode. Node 24 runs the `.ts` files directly through
  its built-in type stripping, so the code uses only erasable syntax (no
  enums, no parameter properties) and imports use `.ts` extensions. `tsc`
  only type-checks. There is no build step for the server or scripts.
- Node 24 or later (`engines.node` is `>=24`).
- pnpm 10.33.2 (`packageManager` field). No npm, no global installs.
- `node:sqlite` (built into Node 24) for the event log. No native database
  dependency.
- zod for validation of fixtures, model output, recordings and HTTP bodies.
- vitest for tests. A setup file replaces `fetch` with a function that
  throws, so a test that tries to reach the network fails.
- Vite with React for the UI. The local Node server runs Vite in middleware
  mode, so one process serves the UI and the API on `127.0.0.1`.

## Dependency checks

Checked on 2026-10-27 with `pnpm view <name>@<version> license scripts time`.
Every version is pinned exactly in `package.json`. Publish age is the number
of days between the version's publish date and 2026-10-27. The rule is to pick
the newest version published at least 7 days earlier.

| Package | Version | Kind | License | Install scripts | Published | Age (days) |
|---|---|---|---|---|---|---|
| react | 19.3.1 | runtime | MIT | none | 2026-10-14 | 12 |
| react-dom | 19.3.1 | runtime | MIT | none | 2026-10-14 | 12 |
| zod | 4.6.7 | runtime | MIT | none | 2026-10-12 | 14 |
| typescript | 7.0.2 | dev | Apache-2.0 | none | 2026-07-08 | 110 |
| vite | 8.3.4 | dev | MIT | none | 2026-10-08 | 18 |
| vitest | 5.0.5 | dev | MIT | none | 2026-10-15 | 11 |
| @types/node | 24.19.2 | dev | MIT | none | 2026-10-09 | 17 |
| @types/react | 19.3.0 | dev | MIT | none | 2026-09-09 | 47 |
| @types/react-dom | 19.3.0 | dev | MIT | none | 2026-09-09 | 47 |
| varlock | 1.17.1 | dev (kept from D0) | MIT | none (prepack only) | 2026-08-25 | 63 |

Notes:

- vite 8.3.5 was the latest on 2026-10-27 but was published 6 days earlier,
  so 8.3.4 is pinned.
- `@types/node` follows the Node 24 runtime line (24.x), not the latest
  major.
- No package is approved to run build scripts. After install, a search of
  every installed `package.json` found no `preinstall`, `install` or
  `postinstall` script, and pnpm reported no ignored builds.
- `@vitejs/plugin-react` is not used. Vite's built-in transform handles JSX
  with the automatic runtime. That saves one dependency. The cost is no React
  fast refresh, which this UI does not need.
- `.ics` files are parsed by a small parser in `src/domain/ics.ts`, so there
  is no calendar dependency.
