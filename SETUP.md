# SETUP

How to get Periapsis running from a clean checkout, and what "clean" means here.

## Requirements

| Item      | Version used                        | Notes                                                                 |
| --------- | ----------------------------------- | --------------------------------------------------------------------- |
| Node.js   | v24.22.0                            | Anything with ESM + `structuredClone` works; 20 LTS or newer is safe. |
| npm       | 11.19.1                             | Ships with Node. `pnpm`/`yarn` are untested.                          |
| A browser | Chrome/Edge/Firefox/Safari, current | Needs WebGL 2 for the 3D view.                                        |

There is no database, no service, no account and no API key. Nothing needs to be configured
before the app runs.

## Install

```bash
git clone <this repository> periapsis
cd periapsis
npm ci
```

`npm ci` is preferred over `npm install`: it installs exactly `package-lock.json` and fails if
the lockfile and `package.json` disagree, which is what makes the pinned versions meaningful.

Every dependency is pinned to an exact version, with no carets. `typescript` is held at 5.9.3
rather than the newest major because `typescript-eslint` does not yet support TypeScript 7
(D-001).

## Run

```bash
npm run dev
```

Then open http://localhost:5183. The dev server binds `localhost` only.

For a production build served from disk:

```bash
npm run build
npm run preview
```

`npm run build` writes a static bundle to `dist/`. It can be served by any static file server;
it makes no network requests at runtime.

## Verify

```bash
npm run verify        # typecheck + lint + unit tests + build
npm run test:e2e      # Playwright, starts its own dev server
```

`npm run verify` is the gate. It must be green before anything is committed, and a claim that
it passed means the command was run and its output read.

The e2e suite is separate because it needs a browser download:

```bash
npx playwright install chromium   # once per machine
npm run test:e2e
```

Headless Chromium needs software GL; `playwright.config.ts` passes
`--use-gl=swiftshader --enable-unsafe-swiftshader` so the WebGL canvas is real rather than a
fallback. Without those flags the tests would exercise the WebGL-failure path.

## Offline

The app is designed to run with the network switched off after install. If a change introduces
a runtime `fetch` or a remote stylesheet, that is a defect, not a preference:

- `fetch` is banned by ESLint inside `src/core` and `src/sim`.
- Nothing in `src/ui` or `src/render` loads a remote resource; fonts are system fonts.
- `dist/` is self-contained apart from the files it ships.

## Releasing

The version has exactly one source: `package.json`. `vite.config.ts` reads it at build time and
injects `__APP_VERSION__`, which the sidebar badge renders, so the number a user sees cannot
disagree with the tag (D-041). Do not type a version into any other file.

1. Edit `version` in `package.json`.
2. `npm install --package-lock-only` to carry it into `package-lock.json`.
3. Add the release's section to `CHANGELOG.md`, newest first.
4. `npm run verify && npm run test:e2e`.
5. `git tag -a v<version> -m "Periapsis <version>"`, then commit.

`tests/version.test.ts` fails if the injected constant and `package.json` disagree, and the shell
e2e test asserts the badge matches a version pattern, so a missed step is caught rather than
shipped.

## Troubleshooting

| Symptom                                 | Cause                                                 | Fix                                                                                                         |
| --------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "Could not start WebGL" in the viewport | No WebGL context available (headless/blocklisted GPU) | The rest of the app still works. Use a browser with WebGL, or run the e2e suite which supplies software GL. |
| `npm ci` fails on a lockfile mismatch   | `package.json` changed without the lockfile           | `npm install` to regenerate, review the diff, commit both.                                                  |
| Port 5183 already in use                | A previous dev server is still running                | Stop it, or change `server.port` in `vite.config.ts` **and** `baseURL` in `playwright.config.ts`.           |
| Playwright cannot find a browser        | Chromium was never downloaded                         | `npx playwright install chromium`.                                                                          |
