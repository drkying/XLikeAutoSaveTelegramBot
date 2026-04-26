import { spawn } from "node:child_process";
import process from "node:process";

const mode = process.argv.includes("--remote") ? "--remote" : "--local";
const configPath = ".wrangler/generated/wrangler.jsonc";

const requiredColumns = {
  users: [
    ["credential_owner_account_id", "TEXT"],
  ],
  accounts: [
    ["x_client_id", "TEXT"],
    ["x_client_secret", "TEXT"],
    ["credential_owner_account_id", "TEXT"],
  ],
  media: [
    ["telegram_file_path", "TEXT"],
    ["telegram_file_url", "TEXT"],
  ],
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  await preflight();

  for (const [table, columns] of Object.entries(requiredColumns)) {
    const existingColumns = await listColumns(table);
    if (existingColumns.size === 0) {
      throw new Error(`Table ${table} does not exist. Apply migrations/0001_init.sql before running schema repair.`);
    }

    for (const [column, type] of columns) {
      if (existingColumns.has(column)) {
        console.log(`${table}.${column}: exists`);
        continue;
      }

      console.log(`${table}.${column}: adding`);
      await executeSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  await executeSql(`
    UPDATE accounts
    SET x_client_id = COALESCE(
          x_client_id,
          (SELECT users.x_client_id FROM users WHERE users.telegram_chat_id = accounts.telegram_chat_id)
        ),
        x_client_secret = COALESCE(
          x_client_secret,
          (SELECT users.x_client_secret FROM users WHERE users.telegram_chat_id = accounts.telegram_chat_id)
        )
    WHERE x_client_id IS NULL
       OR x_client_secret IS NULL
  `);

  await executeSql(`
    CREATE TABLE IF NOT EXISTS author_topics (
        telegram_chat_id   INTEGER NOT NULL,
        author_id          TEXT NOT NULL REFERENCES tweet_authors(author_id),
        topic_name         TEXT NOT NULL,
        message_thread_id  INTEGER NOT NULL,
        created_at         TEXT DEFAULT (datetime('now')),
        updated_at         TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (telegram_chat_id, author_id)
    )
  `);
  await executeSql("CREATE INDEX IF NOT EXISTS idx_author_topics_chat_id ON author_topics(telegram_chat_id)");
  await executeSql("CREATE UNIQUE INDEX IF NOT EXISTS idx_author_topics_chat_thread ON author_topics(telegram_chat_id, message_thread_id)");

  console.log(`D1 schema repair completed for ${mode === "--remote" ? "remote" : "local"} DB.`);
}

async function preflight() {
  return;
}

async function listColumns(table) {
  const output = await runWrangler([
    "d1",
    "execute",
    "DB",
    mode,
    "--config",
    configPath,
    "--yes",
    "--json",
    "--command",
    `PRAGMA table_info(${table});`,
  ]);
  const parsed = JSON.parse(output);
  const rows = parsed.flatMap((item) => item.results ?? []);
  return new Set(rows.map((row) => row.name).filter(Boolean));
}

async function executeSql(sql) {
  await runWrangler([
    "d1",
    "execute",
    "DB",
    mode,
    "--config",
    configPath,
    "--yes",
    "--command",
    sql,
  ]);
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable("wrangler"), args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        if (stderr.trim()) {
          process.stderr.write(stderr);
        }
        resolve(stdout);
        return;
      }

      reject(new Error(`${resolveExecutable("wrangler")} ${args.join(" ")} exited with code ${code ?? "unknown"}.\n${stderr}${stdout}`));
    });
  });
}

function resolveExecutable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}
