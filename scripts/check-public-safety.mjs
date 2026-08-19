import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const self = resolve(fileURLToPath(import.meta.url));
const skippedDirectories = new Set([
  ".git",
  ".playwright-cli",
  ".state",
  "captures",
  "coverage",
  "data",
  "dist",
  "dist-web",
  "node_modules",
  "output",
  "traces",
]);

const environmentSpecificPatterns = [
  { label: "personal home path", pattern: /\/home\/(?:moeu|morita)(?:\/|\b)/giu },
  { label: "personal data path", pattern: /\/data\/morita(?:\/|\b)/giu },
  { label: "private host alias", pattern: /\blab[_-]rdp\b/giu },
  { label: "personal cookie filename", pattern: /\bmoeu-cookies\.txt\b/giu },
  { label: "personal commit email", pattern: /chama1007@icloud\.com/giu },
];

const secretPatterns = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { label: "GitHub OAuth token", pattern: /\bgho_[A-Za-z0-9]{30,}\b/gu },
  { label: "GitHub personal access token", pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/gu },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/gu },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu },
];

const findings = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      continue;
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile() || path === self) {
      continue;
    }

    const info = await stat(path);
    if (info.size > 2_000_000) {
      continue;
    }

    const content = await readFile(path);
    if (content.includes(0)) {
      continue;
    }
    const text = content.toString("utf8");
    const patterns = [...environmentSpecificPatterns, ...secretPatterns];
    for (const { label, pattern } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        findings.push(`${relative(root, path)}: ${label}`);
      }
    }
  }
}

await walk(root);

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (packageJson.private === true) {
  findings.push("package.json: package is marked private");
}
if (packageJson.license !== "MIT") {
  findings.push("package.json: license metadata does not match LICENSE");
}

for (const requiredFile of ["LICENSE", "README.md", "SECURITY.md"]) {
  try {
    await access(resolve(root, requiredFile), constants.R_OK);
  } catch {
    findings.push(`${requiredFile}: required public-release file is missing`);
  }
}

if (findings.length > 0) {
  console.error("Public-release safety checks failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log("Public-release safety checks passed.");
}
