# X Like Auto Save Telegram Bot

部署在 Cloudflare Workers 的 Telegram Bot。支持多账号 OAuth 绑定、按账号独立保存 X API Client ID / Client Secret、按账号轮询点赞、推文转 Telegram MarkdownV2，并把推文与媒体元数据持久化到 D1 / R2。

实现目标与约束见 [docs/design.md](docs/design.md)，执行项见 [docs/checklist.md](docs/checklist.md)，完整配置步骤见 [docs/configuration.md](docs/configuration.md)。

## 本地环境变量

项目现在把仓库内的 `wrangler.jsonc` 作为无实例信息的模板，实际执行前通过 `npm run cf:config` 生成 `.wrangler/generated/wrangler.jsonc`。这个生成文件在 `.wrangler/` 下，不会进入 git；如果你提供 `CF_*` 环境变量，就会绑定到现有资源，否则使用 Wrangler 自动 provisioning。

`.dev.vars` 仍然主要给 `wrangler dev` 使用；线上环境请用 `wrangler secret put` 和 Cloudflare Dashboard / CI 环境变量配置。模板里的 `keep_vars` 已开启，`npm run deploy` 会使用 `wrangler deploy --keep-vars`，这样在没有显式提供 build-time plain-text vars 时，不会把 Dashboard 里已有的运行时变量误覆盖掉。

| 变量 | 必填 | 用途 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token，本地命令、Webhook、消息发送都依赖它 |
| `TELEGRAM_API_BASE` | 否 | Telegram Bot API 基地址；未设置时使用官方 `https://api.telegram.org`，设置为 `https://tgbotapi.drkying.com` 时使用自建接口 |
| `ADMIN_CHAT_ID` | 否 | 接收运行错误和告警的 Telegram Chat ID |
| `WEBHOOK_SECRET` | 否 | `/webhook` 会校验请求头 `X-Telegram-Bot-Api-Secret-Token` |
| `WORKERS_PAID_ENABLED` | 否 | 付费方案状态标记，默认保持 `false` |
| `R2_PUBLIC_DOMAIN` | 否 | R2 自定义公开域名；留空时仍可上传，但不会生成公开 URL |
| `APP_BASE_URL` | 是 | OAuth 回调基地址；本地默认 `http://localhost:8787`，接隧道后改成外网地址 |

如果你要复用已经存在的 Cloudflare 资源，而不是让 Wrangler 自动创建，还可以额外提供这些环境变量：

| 变量 | 必填 | 用途 |
|---|---|---|
| `CF_KV_ID` | 否 | 绑定现有 KV namespace 的正式 ID |
| `CF_KV_PREVIEW_ID` | 否 | 绑定现有 KV namespace 的 preview ID；不填时回退到 `CF_KV_ID` |
| `CF_D1_DATABASE_NAME` | 否 | 绑定现有 D1 的数据库名称，需要和 `CF_D1_DATABASE_ID` 成对提供 |
| `CF_D1_DATABASE_ID` | 否 | 绑定现有 D1 的数据库 ID，需要和 `CF_D1_DATABASE_NAME` 成对提供 |
| `CF_D1_PREVIEW_DATABASE_ID` | 否 | 绑定现有 D1 preview 数据库 ID；不填时回退到 `CF_D1_DATABASE_ID` |
| `CF_R2_BUCKET_NAME` | 否 | 绑定现有 R2 bucket 名称 |
| `CF_SUBREQUEST_LIMIT` | 否 | 仅在 `WORKERS_PAID_ENABLED=true` 时生效；覆盖 Worker 的 `limits.subrequests`，默认 10000 |

## 初始化

先安装依赖并登录 Cloudflare：

```bash
npm install
wrangler login
```

推荐先生成一次有效配置：

```bash
npm run cf:config
```

默认情况下，不需要先手工创建 KV / D1 / R2，也不需要把返回的 ID 写回仓库；`wrangler dev` / `wrangler deploy` 会基于 `wrangler.jsonc` 里的无 ID 绑定走自动 provisioning。

如果你必须复用现有资源，先在 shell、CI 或 `.dev.vars` / `.env` 中提供上面的 `CF_*` 变量，然后重新生成配置。例如：

```bash
$env:CF_KV_ID="your-kv-id"
$env:CF_D1_DATABASE_NAME="your-d1-name"
$env:CF_D1_DATABASE_ID="your-d1-id"
$env:CF_R2_BUCKET_NAME="your-r2-bucket"
npm run cf:config
```

执行数据库初始化时，脚本会按 `migrations/` 目录顺序应用所有 D1 migration，并直接使用 D1 绑定名 `DB`，不再依赖仓库里硬编码的数据库名称：

```bash
npm run db:init:local
npm run db:init:remote
```

如果线上登录或保存时报 `D1_ERROR: no such column: x_client_id`、`credential_owner_account_id` 或 `telegram_file_url`，说明远端 D1 schema 落后于当前代码。先运行：

```bash
npm run db:repair:remote
```

该脚本会先检查列是否存在，只补缺失列，并回填账号级 X 凭据。
远端修复需要当前环境能访问 Cloudflare，并且生成配置里有 D1 `database_id`；如果 `npm run cf:config` 显示 `D1:auto`，请先设置 `CF_D1_DATABASE_NAME` 和 `CF_D1_DATABASE_ID`。

## 本地开发

```bash
npm run build
npm run dev
npm run dev:scheduled
```

- `npm run build` 会先生成 Workers 类型、执行 TypeScript 检查，并初始化本地 D1。
- `npm run dev` 用于本地 HTTP / Bot 调试。
- `npm run dev:scheduled` 用于手动触发 Cron 路径。
- 所有 npm 脚本都会先生成 `.wrangler/generated/wrangler.jsonc`，所以切换 `CF_*` 或运行时变量后，重新执行脚本即可。
- Bot 支持 `/setup <account_id>` 为单个已连接账号更新 API 凭据，也支持 `/login <account_id>` 对单个账号重新授权。
- `/setup` 在保存前会校验 X Client ID / Client Secret 是否有效；输入过程中如改用其他命令或菜单操作，会自动中断本次配置。可通过 `/credentials` 查看已保存凭据、它们与账号的对应关系，并用 `/credentials clear <account_id>` 让某个账号改回默认凭据。
- Bot 默认英文，支持 `/language` 在英文与中文之间切换；主菜单按钮使用无斜杠文案，但底层命令仍保持 `/start`、`/login` 等形式可直接输入。
- 如果 Bot 运行在启用了 Topics 的 Telegram 群组/超级群组中，新保存的点赞推文会按发推人自动建话题，并持续发到该作者对应的话题；如果群组不支持话题，则回退到主聊天发送。
- 需要测试 OAuth 或 Telegram webhook 时，先把本地服务通过 ngrok / cloudflared 等工具暴露出去，再同步更新：
  - `.dev.vars` 里的 `APP_BASE_URL`
  - X App Redirect URI：`<APP_BASE_URL>/auth/callback`
  - Telegram webhook URL：`<APP_BASE_URL>/webhook`

## 部署

部署前确认生产环境 `APP_BASE_URL` 已通过环境变量或 Dashboard 运行时变量指向 Worker 域名 / 自定义域名，且 X App Redirect URI 已改成同一地址。

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_CHAT_ID
wrangler secret put WEBHOOK_SECRET
npm run deploy
```

- `npm run deploy` 现在会先执行 `npm run build`，在生成配置里已经拿到 `database_id` 时先应用远程 D1 migration，再用 `wrangler deploy --keep-vars` 部署，部署后再兜底检查一次远程 migration。
- 如果你使用 Cloudflare Git 自动构建，`Settings > Build > Build variables and secrets` 与 Worker 运行时变量是两套东西。`CF_D1_DATABASE_NAME`、`CF_D1_DATABASE_ID`、`CF_KV_ID`、`CF_R2_BUCKET_NAME` 这类会参与生成 Wrangler 绑定配置的值，必须放到 Build variables 里，不能只放在 Worker 运行时变量里。
- `APP_BASE_URL`、`TELEGRAM_API_BASE`、`R2_PUBLIC_DOMAIN`、`WORKERS_PAID_ENABLED` 如果只想继续沿用 Dashboard 当前运行时值，可以不放到 Build variables；如果你希望每次构建时由代码侧覆盖它们，也需要同步放到 Build variables。

部署后设置并校验 Telegram webhook；如果没有启用 `WEBHOOK_SECRET`，去掉 `secret_token` 参数。未设置 `TELEGRAM_API_BASE` 时使用官方接口；使用自建接口时把命令里的域名改为 `tgbotapi.drkying.com`：

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker-domain>/webhook&secret_token=<WEBHOOK_SECRET>"
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

## 成本与维护

- X API 没有免费层，先预充值 credits，并至少每周检查一次余额和调用量。
- 上线初期保持较大的 `poll_interval_min` 和有限轮询时段，先确认真实单账号成本再放开。
- 项目已输出结构化 observability 日志到 Cloudflare Workers logs，关键链路会带 `request_id`、`job_id`、`poll_id` 等字段，建议结合 `wrangler tail` 和 Dashboard 检索。
- `ADMIN_CHAT_ID` 建议始终配置，结合 `wrangler tail` 和 Cloudflare Dashboard 观察 Workers CPU、Cron、D1、KV、R2 的错误与用量。
- Workers 免费层 CPU 预算很紧；高频轮询或媒体较多时，先监控再决定是否真的启用付费方案。
- 每月检查 D1 数据量、R2 存储量、`x_only` / `failed` 媒体占比，以及 refresh token 失效率；异常用户需要重新 `/login`。
- D1 Time Travel 适合短期回滚，不等于长期备份；需要更长保留时，补充定期导出策略。
