import { defineConfig } from "vite";

import tailwindcss from "@tailwindcss/vite";
import { PLATFORM_THEME_CSS, PLATFORM_THEME_SCRIPT } from "../src/domain/platform-theme.ts";

export default defineConfig({
  plugins: [tailwindcss(), { name: "platform-theme", transformIndexHtml: () => [{ tag: "style", children: PLATFORM_THEME_CSS, injectTo: "head" }, { tag: "script", children: PLATFORM_THEME_SCRIPT, injectTo: "head" }] }],
  base: "/admin/",
  build: {
    outDir: "dist",
    sourcemap: false,
    rolldownOptions: { input: { community: 'community.html' } },
  },
});
