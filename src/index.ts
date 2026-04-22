import { Hono } from "hono";
import { handleAuthCallback, handleAuthLogin } from "./auth";
import { createWebhookHandler } from "./bot";
import { pollAllAccounts } from "./poller";
import { notifyAdmin } from "./sender";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "x-like-save-bot",
    workersPaidEnabled: c.env.WORKERS_PAID_ENABLED ?? "false",
  }),
);

app.get("/auth/login", handleAuthLogin);
app.get("/auth/callback", handleAuthCallback);

app.post("/webhook", async (c) => {
  if (c.env.WEBHOOK_SECRET) {
    const header = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (header !== c.env.WEBHOOK_SECRET) {
      return c.text("Unauthorized", 401);
    }
  }

  const webhook = createWebhookHandler(c.env);
  return webhook(c.req.raw);
});

app.onError(async (error, c) => {
  await notifyAdmin(
    c.env,
    `Unhandled worker error: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  return c.json({ error: "Internal Server Error" }, 500);
});

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    return app.fetch(request, env, executionContext);
  },
  scheduled(_controller: ScheduledController, env: Env, executionContext: ExecutionContext) {
    executionContext.waitUntil(
      (async () => {
        try {
          await pollAllAccounts(env);
        } catch (error) {
          await notifyAdmin(
            env,
            `Scheduled polling failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      })(),
    );
  },
};
