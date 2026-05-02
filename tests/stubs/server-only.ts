// Test-side stub for the Next.js `server-only` import. The real
// module throws at *build* time if a "server-only" module ends up
// in a client bundle. In tests (node) it does nothing — this stub
// keeps imports of server modules satisfiable from vitest.
export {};
