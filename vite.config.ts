import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
});
