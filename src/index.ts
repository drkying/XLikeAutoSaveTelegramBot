import { Hono } from "hono";
import { handleAuthCallback, handleAuthLogin } from "./auth";
import { createWebhookHandler } from "./bot";
import { createCorrelationId, logError, logInfo, logWarn, serializeError } from "./observability";
import { pollAllAccounts } from "./poller";
import { buildRuntimeStatus, isRuntimeStatusAuthorized } from "./runtime-status";
import { ensureD1Schema } from "./schema";
import { notifyAdmin } from "./sender";
import type { Env } from "./types";

const app = new Hono<{
  Bindings: Env;
  Variables: {
    requestId: string;
    requestStartedAt: number;
  };
}>();

app.use("*", async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? createCorrelationId("req");
  const requestStartedAt = Date.now();
  c.set("requestId", requestId);
  c.set("requestStartedAt", requestStartedAt);

  await next();

  const url = new URL(c.req.url);
  logInfo("http.request.completed", {
    request_id: requestId,
    method: c.req.method,
    path: url.pathname,
    status: c.res.status,
    duration_ms: Date.now() - requestStartedAt,
  });
});

app.use("*", async (c, next) => {
  await ensureD1Schema(c.env);
  await next();
});

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "x-like-save-bot",
    workersPaidEnabled: c.env.WORKERS_PAID_ENABLED ?? "false",
  }),
);

app.get("/status", async (c) => {
  if (!isRuntimeStatusAuthorized(c.req.raw, c.env)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json(await buildRuntimeStatus(c.env));
});

app.get("/auth/login", handleAuthLogin);
app.get("/auth/callback", handleAuthCallback);

app.post("/webhook", async (c) => {
  if (c.env.WEBHOOK_SECRET) {
    const header = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (header !== c.env.WEBHOOK_SECRET) {
      logWarn("webhook.unauthorized", {
        request_id: c.get("requestId"),
        path: new URL(c.req.url).pathname,
      });
      return c.text("Unauthorized", 401);
    }
  }

  const webhook = createWebhookHandler(c.env);
  logInfo("webhook.accepted", {
    request_id: c.get("requestId"),
    path: new URL(c.req.url).pathname,
  });
  return webhook(c.req.raw);
});

app.onError(async (error, c) => {
  logError("http.request.failed", {
    request_id: c.get("requestId"),
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    duration_ms: Date.now() - c.get("requestStartedAt"),
    ...serializeError(error),
  });
  await notifyAdmin(
    c.env,
    `Unhandled worker error [${c.get("requestId")}]: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  return c.json({ error: "Internal Server Error" }, 500);
});

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    return app.fetch(request, env, executionContext);
  },
  scheduled(_controller: ScheduledController, env: Env, executionContext: ExecutionContext) {
    const jobId = createCorrelationId("cron");
    executionContext.waitUntil(
      (async () => {
        try {
          logInfo("cron.started", {
            job_id: jobId,
            cron: "*/5 * * * *",
          });
          await ensureD1Schema(env);
          await pollAllAccounts(env, { jobId });
          logInfo("cron.completed", {
            job_id: jobId,
          });
        } catch (error) {
          logError("cron.failed", {
            job_id: jobId,
            ...serializeError(error),
          });
          await notifyAdmin(
            env,
            `Scheduled polling failed [${jobId}]: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      })(),
    );
  },
};
