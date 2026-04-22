# X Like Auto Save Telegram Bot

部署在 Cloudflare Workers 的 Telegram Bot。每个 Telegram 用户自带自己的 X API Client ID / Client Secret，支持多账号 OAuth 绑定、按账号轮询点赞、推文转 Telegram MarkdownV2，并把推文与媒体元数据持久化到 D1 / R2。

实现目标与约束见 [docs/design.md](docs/design.md)，执行项见 [docs/checklist.md](docs/checklist.md)，完整配置步骤见 [docs/configuration.md](docs/configuration.md)。

## 本地环境变量

`.dev.vars` 只给 `wrangler dev` 使用；线上环境请用 `wrangler secret put` 和 `wrangler.toml` / Cloudflare Dashboard 配置。

| 变量 | 必填 | 用途 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token，本地命令、Webhook、消息发送都依赖它 |
| `ADMIN_CHAT_ID` | 否 | 接收运行错误和告警的 Telegram Chat ID |
| `WEBHOOK_SECRET` | 否 | `/webhook` 会校验请求头 `X-Telegram-Bot-Api-Secret-Token` |
| `WORKERS_PAID_ENABLED` | 否 | 付费方案状态标记，默认保持 `false` |
| `R2_PUBLIC_DOMAIN` | 否 | R2 自定义公开域名；留空时仍可上传，但不会生成公开 URL |
| `APP_BASE_URL` | 是 | OAuth 回调基地址；本地默认 `http://localhost:8787`，接隧道后改成外网地址 |

## 初始化

先安装依赖并登录 Cloudflare：

```bash
npm install
wrangler login
```

创建 Cloudflare 资源，然后把返回的 ID 填回 `wrangler.toml`：

```bash
wrangler kv namespace create "KV"
wrangler kv namespace create "KV" --preview
wrangler d1 create "CF_D1_DATABASE_NAME_REMOVED"
wrangler r2 bucket create "CF_R2_BUCKET_NAME_REMOVED"
```

执行数据库迁移；如果你改过 D1 名称，把命令里的 `CF_D1_DATABASE_NAME_REMOVED` 换成实际值：

```bash
wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --local --file=migrations/0001_init.sql
wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --remote --file=migrations/0001_init.sql
```

## 本地开发

```bash
npm run build
npm run dev
npm run dev:scheduled
```

- `npm run build` 会先生成 Workers 类型、执行 TypeScript 检查，并初始化本地 D1。
- `npm run dev` 用于本地 HTTP / Bot 调试。
- `npm run dev:scheduled` 用于手动触发 Cron 路径。
- 需要测试 OAuth 或 Telegram webhook 时，先把本地服务通过 ngrok / cloudflared 等工具暴露出去，再同步更新：
  - `.dev.vars` 里的 `APP_BASE_URL`
  - X App Redirect URI：`<APP_BASE_URL>/auth/callback`
  - Telegram webhook URL：`<APP_BASE_URL>/webhook`

## 部署

部署前确认生产环境 `APP_BASE_URL` 已指向 Worker 域名或自定义域名，且 X App Redirect URI 已改成同一地址。

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_CHAT_ID
wrangler secret put WEBHOOK_SECRET
npm run deploy
```

- `npm run deploy` 会自动先执行 `npm run build`，再执行远程 D1 初始化，然后才真正部署。

部署后设置并校验 Telegram webhook；如果没有启用 `WEBHOOK_SECRET`，去掉 `secret_token` 参数：

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker-domain>/webhook&secret_token=<WEBHOOK_SECRET>"
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

## 成本与维护

- X API 没有免费层，先预充值 credits，并至少每周检查一次余额和调用量。
- 上线初期保持较大的 `poll_interval_min` 和有限轮询时段，先确认真实单账号成本再放开。
- `ADMIN_CHAT_ID` 建议始终配置，结合 `wrangler tail` 和 Cloudflare Dashboard 观察 Workers CPU、Cron、D1、KV、R2 的错误与用量。
- Workers 免费层 CPU 预算很紧；高频轮询或媒体较多时，先监控再决定是否真的启用付费方案。
- 每月检查 D1 数据量、R2 存储量、`x_only` / `failed` 媒体占比，以及 refresh token 失效率；异常用户需要重新 `/login`。
- D1 Time Travel 适合短期回滚，不等于长期备份；需要更长保留时，补充定期导出策略。
