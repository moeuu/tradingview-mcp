import { rm } from "node:fs/promises";

await Promise.all(
  ["dist", "dist-web", "coverage", "output", ".playwright-cli"].map((path) =>
    rm(new URL(`../${path}`, import.meta.url), { force: true, recursive: true }),
  ),
);
