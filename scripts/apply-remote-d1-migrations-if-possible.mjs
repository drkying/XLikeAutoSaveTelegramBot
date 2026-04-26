import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const generatedConfigPath = path.join(projectRoot, ".wrangler", "generated", "wrangler.jsonc");

const generatedConfig = JSON.parse(await readFile(generatedConfigPath, "utf8"));
const d1Config = generatedConfig.d1_databases?.find((binding) => binding.binding === "DB")
  ?? generatedConfig.d1_databases?.[0];

if (!d1Config?.database_id) {
  console.warn(
    [
      "Generated Wrangler config has no DB.database_id; trying remote D1 migrations by binding name DB.",
      "If this fails in Cloudflare Git builds, add CF_D1_DATABASE_NAME and CF_D1_DATABASE_ID to Build variables and secrets.",
    ].join("\n"),
  );
}

await runCommand(resolveExecutable("wrangler"), [
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  ".wrangler/generated/wrangler.jsonc"
]);

await runCommand(process.execPath, [
  "scripts/repair-d1-schema.mjs",
  "--remote",
]);

function resolveExecutable(name) {
  if (process.platform === "win32") {
    return `${name}.cmd`;
  }

  return name;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}
