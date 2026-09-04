import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @vitejs/plugin-react is listed in package.json but was never registered
// anywhere, so Fast Refresh/HMR silently didn't work in dev. This wires it up.
export default defineConfig({
  plugins: [react()],
});
