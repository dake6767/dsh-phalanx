import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  build: {
    outDir: "dist",
    sourcemap: false,
    rolldownOptions: { input: { community: 'community.html' } },
  },
});
