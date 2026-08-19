#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createRuntime } from "./runtime.js";

export async function startStandalone(): Promise<void> {
  const runtime = await createRuntime();
  const api = await runtime.api.ensure();
  const tokenHint = runtime.config.apiToken ? " (Bearer token required for /api/*)" : "";
  console.error(`Market chart API listening at ${api.url}${tokenHint}`);

  const close = async () => {
    await runtime.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function isEntrypoint(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isEntrypoint()) {
  startStandalone().catch((error: unknown) => {
    console.error("Failed to start market chart API:", error);
    process.exitCode = 1;
  });
}
