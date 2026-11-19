/// <reference types="vite/client" />

/**
 * The application version, injected at build time from `package.json` by `vite.config.ts`.
 *
 * Declared here because TypeScript has no way to know about a value Vite substitutes at compile
 * time. It is a literal in the built bundle, not a runtime lookup, so nothing reads a file or a
 * network resource to display a version.
 */
declare const __APP_VERSION__: string;
