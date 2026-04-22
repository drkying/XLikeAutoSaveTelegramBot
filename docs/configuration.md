# X Like Auto Save Telegram Bot 配置文档

这份文档只关注“需要配置什么”和“按什么顺序配置”。

- 设计来源：[design.md](./design.md)
- 开发检查项：[checklist.md](./checklist.md)

## 1. 配置总览

项目需要配置 6 类内容：

1. Cloudflare 资源：Workers、KV、D1、R2
2. Worker 配置文件：`wrangler.toml`
3. 本地开发变量：`.dev.vars`
4. 线上 Secrets：`TELEGRAM_BOT_TOKEN`、`ADMIN_CHAT_ID`、`WEBHOOK_SECRET`
5. 第三方平台设置：Telegram Webhook、X App OAuth 2.0
6. 数据库初始化：执行 D1 migration

需要特别注意：

- `X Client ID / Client Secret` 不是全局环境变量。
- 这是多租户设计，每个 Telegram 用户通过 `/setup` 在 Bot 内提交自己的 X API 凭据。
- 因此 Worker 侧只需要配置 Telegram、Cloudflare 和运行时相关变量，不需要在服务器上预置统一的 X API Key。

## 2. 前置准备

先准备好这些账号和信息：

- Cloudflare 账号
- Telegram Bot Token
- Telegram 管理员 Chat ID
- X Developer App
- X App 的 OAuth 2.0 Redirect URI

你最终至少会用到这些值：

| 名称 | 用途 | 例子 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot 发消息、接收 webhook | `123456:ABC...` |
| `ADMIN_CHAT_ID` | 接收告警 | `123456789` |
| `WEBHOOK_SECRET` | 校验 Telegram webhook 请求 | 自定义随机字符串 |
| `APP_BASE_URL` | OAuth 回调和 webhook 根地址 | `https://your-worker.example.workers.dev` |
| `KV_ID` / `KV_PREVIEW_ID` | `wrangler.toml` 中 KV 绑定 | Cloudflare 返回的 namespace id |
| `D1_ID` / `D1_PREVIEW_ID` | `wrangler.toml` 中 D1 绑定 | Cloudflare 返回的 database id |
| `R2_PUBLIC_DOMAIN` | R2 文件公开访问域名，可选 | `https://media.example.com` |

## 3. Cloudflare 资源创建顺序

推荐按下面顺序创建：

```bash
wrangler login
wrangler kv namespace create "KV"
wrangler kv namespace create "KV" --preview
wrangler d1 create "CF_D1_DATABASE_NAME_REMOVED"
wrangler r2 bucket create "CF_R2_BUCKET_NAME_REMOVED"
```

执行后把 Cloudflare 返回的资源 ID 填到 `wrangler.toml`。

## 4. `wrangler.toml` 配置

当前项目里的 [wrangler.toml](../wrangler.toml) 需要你替换这些占位值：

```toml
[[kv_namespaces]]
binding = "KV"
id = "<KV_ID>"
preview_id = "<KV_PREVIEW_ID>"

[[d1_databases]]
binding = "DB"
database_name = "CF_D1_DATABASE_NAME_REMOVED"
database_id = "<D1_ID>"
preview_database_id = "<D1_PREVIEW_ID>"
```

### `vars` 字段说明

```toml
[vars]
WORKERS_PAID_ENABLED = "false"
R2_PUBLIC_DOMAIN = ""
APP_BASE_URL = "http://localhost:8787"
```

含义如下：

| 变量 | 是否必填 | 说明 |
|---|---|---|
| `WORKERS_PAID_ENABLED` | 否 | 仅作运行时标记，默认 `false` |
| `R2_PUBLIC_DOMAIN` | 否 | 配了以后媒体可生成公开 URL；不配也能上传，但链接字段可能为空 |
| `APP_BASE_URL` | 是 | 本地开发时一般为 `http://localhost:8787`；部署后必须改成线上 Worker 地址 |

## 5. 本地开发配置：`.dev.vars`

项目已经提供了模板：

- [`.dev.vars`](../.dev.vars)
- [`.dev.vars.example`](../.dev.vars.example)

本地开发时需要至少填这些值：

```dotenv
TELEGRAM_BOT_TOKEN=__YOUR_TELEGRAM_BOT_TOKEN__
ADMIN_CHAT_ID=
WEBHOOK_SECRET=
WORKERS_PAID_ENABLED=false
R2_PUBLIC_DOMAIN=
APP_BASE_URL=http://localhost:8787
```

说明：

- `.dev.vars` 只给 `wrangler dev` 使用。
- 这里不要放真实的 X Client ID / Secret 统一配置，因为用户会在 Bot 里通过 `/setup` 提交自己的凭据。
- 如果你需要测试 OAuth 回调或 Telegram webhook，本地要配隧道地址，并把 `APP_BASE_URL` 改成公网地址。

## 6. 线上 Secrets 配置

生产环境 Secrets 通过 `wrangler secret put` 配置：

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_CHAT_ID
wrangler secret put WEBHOOK_SECRET
```

建议：

- `TELEGRAM_BOT_TOKEN` 必配
- `ADMIN_CHAT_ID` 强烈建议配置，否则运行时错误只能看 Dashboard / 日志
- `WEBHOOK_SECRET` 建议配置，用于校验 `X-Telegram-Bot-Api-Secret-Token`

## 7. X App 配置步骤

这个项目的 X 侧重点不是“全局 API Key”，而是“用户自带 Key”。

### 你需要在 X Developer Portal 做的事

1. 创建 Project 和 App
2. 开启 OAuth 2.0 User Authentication
3. 给 App 配置这些权限：
   - `tweet.read`
   - `users.read`
   - `like.read`
   - `offline.access`
4. 配置 Redirect URI：
   - 本地调试：`<APP_BASE_URL>/auth/callback`
   - 线上部署：`https://<worker-domain>/auth/callback`

### 用户侧操作

1. 在 Telegram 中执行 `/setup`
2. 依次输入自己的 `Client ID` 和 `Client Secret`
3. 执行 `/login`
4. 打开授权链接完成绑定

因此：

- Worker 不保存统一的 X API 全局密钥
- 每个 Telegram 用户保存自己的 X 凭据到 D1 `users` 表
- 每个 X 账号自己的 Access Token / Refresh Token 存在 `accounts` 表

## 8. Telegram 配置步骤

### 创建 Bot

1. 通过 `@BotFather` 创建 Bot
2. 记录 `TELEGRAM_BOT_TOKEN`
3. 如果需要管理员告警，记录自己的 `Chat ID`

### 设置 Webhook

部署后执行：

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<APP_BASE_URL_HOST>/webhook&secret_token=<WEBHOOK_SECRET>"
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

如果你不使用 `WEBHOOK_SECRET`，把 `secret_token` 参数删掉。

### Webhook 地址要求

- 本地开发联调：隧道地址 + `/webhook`
- 生产环境：Worker 域名 + `/webhook`

## 9. R2 公开域名配置

`R2_PUBLIC_DOMAIN` 不是必填，但建议配置。

不配置时：

- R2 仍可上传
- `r2_key` 仍会保存
- `r2_public_url` 可能为空

配置后：

- 可直接生成媒体公开 URL
- `/convert` 和失败回退链路更好用
- 后续 Web 访问也更方便

推荐格式：

```text
https://media.example.com
```

## 10. 数据库初始化步骤

建表 SQL 在 [migrations/0001_init.sql](../migrations/0001_init.sql)。

本地和远程建议都执行一次：

```bash
wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --local --file=migrations/0001_init.sql
wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --remote --file=migrations/0001_init.sql
```

如果你的数据库名称不是 `CF_D1_DATABASE_NAME_REMOVED`，把命令中的名称替换成实际值。

## 11. 推荐配置顺序

建议完全按这个顺序做：

1. `npm install`
2. `wrangler login`
3. 创建 KV / D1 / R2
4. 填写 `wrangler.toml`
5. 填写 `.dev.vars`
6. 执行 D1 migration
7. 配置 X App Redirect URI
8. 配置 Worker Secrets
9. `npm run check`
10. `npm run dev`
11. 用隧道地址联调 `/auth/callback` 和 `/webhook`
12. `npm run deploy`
13. 设置 Telegram webhook

## 12. 本地联调时必须同步修改的地方

如果你把本地服务暴露到公网，至少要同步 3 个地方：

1. `.dev.vars` 中的 `APP_BASE_URL`
2. X App 的 Redirect URI
3. Telegram Webhook URL

这三个值必须使用同一套外网基地址，否则：

- `/login` 生成的授权链接会回调失败
- Telegram webhook 会打到错误地址

## 13. 生产前检查

部署前确认：

- `wrangler.toml` 中的 KV / D1 ID 已替换
- `APP_BASE_URL` 已切到线上域名
- D1 migration 已执行
- `TELEGRAM_BOT_TOKEN` 已设置
- `WEBHOOK_SECRET` 已设置或明确决定不用
- X App Redirect URI 已切到线上地址
- Telegram webhook 已指向线上 `/webhook`
- `ADMIN_CHAT_ID` 已配置

## 14. 运维建议

至少定期检查这些内容：

- X API credits 余额和消耗速率
- Cloudflare Workers CPU 使用情况
- D1 / KV / R2 用量
- `x_only`、`failed` 媒体比例
- token 刷新失败比例
- `wrangler tail` 和管理员告警消息

如果只想先低成本试运行：

- 保持 `WORKERS_PAID_ENABLED=false`
- 提高轮询间隔
- 缩小轮询时段
- 优先观察单账号成本和错误率
