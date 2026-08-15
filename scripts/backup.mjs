import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const date = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const outputDirectory = resolve("backups");
const outputPath = resolve(outputDirectory, `backup-${date}.sql`);
mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["wrangler", "d1", "export", "composa", "--remote", "--output", outputPath],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
