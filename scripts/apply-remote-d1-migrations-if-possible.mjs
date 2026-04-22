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
    "Skipping remote D1 migrations: generated Wrangler config still has no database_id for binding DB."
  );
  console.warn(
    "Cloudflare Git builds only expose Settings > Build > Build variables and secrets at build time."
  );
  console.warn(
    "If you need automated remote migrations against an existing database, add both CF_D1_DATABASE_NAME and CF_D1_DATABASE_ID there, then redeploy."
  );
  console.warn(
    "If this was the first deploy using automatic provisioning, rerun `npm run db:init:remote` after Wrangler has linked a concrete D1 database."
  );
  process.exit(0);
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
