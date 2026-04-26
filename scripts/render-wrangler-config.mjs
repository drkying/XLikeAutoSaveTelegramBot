import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const sourceConfigPath = path.join(projectRoot, "wrangler.jsonc");
const outputDir = path.join(projectRoot, ".wrangler", "generated");
const outputConfigPath = path.join(outputDir, "wrangler.jsonc");

const baseConfig = JSON.parse(await readFile(sourceConfigPath, "utf8"));
const env = await loadEnv();

applyExistingResourceOverrides(baseConfig, env);
applyRuntimeVarOverrides(baseConfig, env);
applyRuntimeLimits(baseConfig, env);
normalizeConfigPaths(baseConfig);

await mkdir(outputDir, { recursive: true });
await writeFile(outputConfigPath, JSON.stringify(baseConfig, null, 2) + "\n", "utf8");

const kvConfig = baseConfig.kv_namespaces?.[0] ?? {};
const d1Config = baseConfig.d1_databases?.[0] ?? {};
const r2Config = baseConfig.r2_buckets?.[0] ?? {};

console.log(
  [
    `Generated ${path.relative(projectRoot, outputConfigPath)}`,
    `KV:${kvConfig.id ? "existing" : "auto"}`,
    `D1:${d1Config.database_id ? "existing" : "auto"}`,
    `R2:${r2Config.bucket_name ? "existing" : "auto"}`
  ].join(" | ")
);

function applyExistingResourceOverrides(config, envSource) {
  const kvConfig = config.kv_namespaces?.[0];
  if (kvConfig) {
    const kvId = readOptional(envSource, "CF_KV_ID");
    const kvPreviewId = readOptional(envSource, "CF_KV_PREVIEW_ID") ?? kvId;
    if (kvId) {
      kvConfig.id = kvId;
    }
    if (kvPreviewId) {
      kvConfig.preview_id = kvPreviewId;
    }
  }

  const d1Config = config.d1_databases?.[0];
  if (d1Config) {
    const databaseName = readOptional(envSource, "CF_D1_DATABASE_NAME");
    const databaseId = readOptional(envSource, "CF_D1_DATABASE_ID");
    const previewDatabaseId = readOptional(envSource, "CF_D1_PREVIEW_DATABASE_ID") ?? databaseId;

    if (Boolean(databaseName) !== Boolean(databaseId)) {
      throw new Error("Set both CF_D1_DATABASE_NAME and CF_D1_DATABASE_ID when binding an existing D1 database.");
    }

    if (databaseName) {
      d1Config.database_name = databaseName;
    }
    if (databaseId) {
      d1Config.database_id = databaseId;
    }
    if (previewDatabaseId) {
      d1Config.preview_database_id = previewDatabaseId;
    }
  }

  const r2Config = config.r2_buckets?.[0];
  if (r2Config) {
    const bucketName = readOptional(envSource, "CF_R2_BUCKET_NAME");
    if (bucketName) {
      r2Config.bucket_name = bucketName;
    }
  }
}

function applyRuntimeVarOverrides(config, envSource) {
  const managedVarNames = new Set([
    "WORKERS_PAID_ENABLED",
    "R2_PUBLIC_DOMAIN",
    "APP_BASE_URL",
    "TELEGRAM_API_BASE"
  ]);
  const runtimeVars = Object.fromEntries(
    Object.entries(config.vars ?? {}).filter(([key]) => !managedVarNames.has(key))
  );

  const workersPaidEnabled = readOptional(envSource, "WORKERS_PAID_ENABLED");
  if (workersPaidEnabled) {
    runtimeVars.WORKERS_PAID_ENABLED = workersPaidEnabled;
  }

  const r2PublicDomain = readOptional(envSource, "R2_PUBLIC_DOMAIN");
  if (r2PublicDomain) {
    runtimeVars.R2_PUBLIC_DOMAIN = r2PublicDomain;
  }

  const appBaseUrl = readOptional(envSource, "APP_BASE_URL");
  if (appBaseUrl) {
    runtimeVars.APP_BASE_URL = appBaseUrl;
  }

  const telegramApiBase = readOptional(envSource, "TELEGRAM_API_BASE");
  if (telegramApiBase) {
    runtimeVars.TELEGRAM_API_BASE = telegramApiBase;
  }

  if (Object.keys(runtimeVars).length > 0) {
    config.vars = runtimeVars;
    return;
  }

  delete config.vars;
}

function applyRuntimeLimits(config, envSource) {
  const paidEnabled = (readOptional(envSource, "WORKERS_PAID_ENABLED") ?? "false").toLowerCase() === "true";
  if (!paidEnabled) {
    delete config.limits;
    return;
  }

  const configuredSubrequests = Number(readOptional(envSource, "CF_SUBREQUEST_LIMIT") ?? "10000");
  if (!Number.isFinite(configuredSubrequests) || configuredSubrequests <= 0) {
    throw new Error("CF_SUBREQUEST_LIMIT must be a positive number when provided.");
  }

  config.limits = {
    ...(config.limits ?? {}),
    subrequests: configuredSubrequests,
  };
}

function normalizeConfigPaths(config) {
  if (config.main) {
    const absoluteMainFile = path.resolve(projectRoot, config.main);
    config.main = path.relative(outputDir, absoluteMainFile).split(path.sep).join("/");
  }

  const d1Config = config.d1_databases?.[0];
  if (!d1Config?.migrations_dir) {
    return;
  }

  const absoluteMigrationsDir = path.resolve(projectRoot, d1Config.migrations_dir);
  d1Config.migrations_dir = path.relative(outputDir, absoluteMigrationsDir).split(path.sep).join("/");
}

function readOptional(envSource, key) {
  const value = envSource[key];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

async function loadEnv() {
  const envFiles = resolveEnvFiles();
  const loaded = {};

  for (const envFile of envFiles) {
    if (!existsSync(envFile)) {
      continue;
    }

    const contents = await readFile(envFile, "utf8");
    Object.assign(loaded, parseEnvFile(contents));
  }

  return {
    ...loaded,
    ...process.env
  };
}

function resolveEnvFiles() {
  const cloudflareEnv = process.env.CLOUDFLARE_ENV?.trim();
  const files = [];
  const environmentDevVars = cloudflareEnv ? path.join(projectRoot, `.dev.vars.${cloudflareEnv}`) : null;

  if (environmentDevVars && existsSync(environmentDevVars)) {
    files.push(environmentDevVars);
  } else {
    files.push(path.join(projectRoot, ".dev.vars"));
  }

  files.push(path.join(projectRoot, ".env"));

  if (cloudflareEnv) {
    files.push(path.join(projectRoot, `.env.${cloudflareEnv}`));
  }

  files.push(path.join(projectRoot, ".env.local"));

  if (cloudflareEnv) {
    files.push(path.join(projectRoot, `.env.${cloudflareEnv}.local`));
  }

  return files;
}

function parseEnvFile(contents) {
  const parsed = {};

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const inlineCommentIndex = value.search(/\s+#/u);
      if (inlineCommentIndex >= 0) {
        value = value.slice(0, inlineCommentIndex).trim();
      }
    }

    parsed[key] = value;
  }

  return parsed;
}
