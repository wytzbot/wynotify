import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// @vitejs/plugin-react is listed in package.json but was never registered
// anywhere, so Fast Refresh/HMR silently didn't work in dev. This wires it up.

// Single source of truth for the app version: package.json. Everything that
// needs to know "what version is this" (the stale-tab reload check, the
// service-worker query strings, the health check) should read from here
// instead of a hand-copied literal, so a release can never bump the number
// in one place and forget another.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
