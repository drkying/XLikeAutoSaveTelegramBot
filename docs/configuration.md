# X Like Auto Save Telegram Bot 配置文档

这份文档只关注“需要配置什么”和“按什么顺序配置”。

- 设计来源：[design.md](./design.md)
- 开发检查项：[checklist.md](./checklist.md)

## 1. 配置总览

项目需要配置 6 类内容：

1. Cloudflare 资源：Workers、KV、D1、R2
2. Worker 配置文件：仓库内模板 `wrangler.jsonc`，以及脚本生成的 `.wrangler/generated/wrangler.jsonc`
3. 本地开发变量：`.dev.vars`
4. 线上 Secrets：`TELEGRAM_BOT_TOKEN`、`ADMIN_CHAT_ID`、`WEBHOOK_SECRET`
5. 第三方平台设置：Telegram Webhook、X App OAuth 2.0
6. 数据库初始化：执行 D1 migration

需要特别注意：

- `X Client ID / Client Secret` 不是全局环境变量。
- 这是多租户设计，每个 Telegram 用户先可通过 `/setup` 提交默认 X API 凭据，已连接的 X 账号也可以通过 `/setup <account_id>` 单独更新自己的 API 凭据。
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
| `TELEGRAM_API_BASE` | Telegram Bot API 基地址，可选 | `https://tgbotapi.drkying.com` |
| `ADMIN_CHAT_ID` | 接收告警 | `123456789` |
| `WEBHOOK_SECRET` | 校验 Telegram webhook 请求 | 自定义随机字符串 |
| `APP_BASE_URL` | OAuth 回调和 webhook 根地址 | `https://your-worker.example.workers.dev` |
| `R2_PUBLIC_DOMAIN` | R2 文件公开访问域名，可选 | `https://media.example.com` |

只有在“复用已经存在的 Cloudflare 资源”时，才额外需要这些值：

| 名称 | 用途 | 例子 |
|---|---|---|
| `CF_KV_ID` / `CF_KV_PREVIEW_ID` | 覆盖生成配置里的 KV 绑定 | Cloudflare 返回的 namespace id |
| `CF_D1_DATABASE_NAME` / `CF_D1_DATABASE_ID` | 覆盖生成配置里的 D1 绑定 | 已有 D1 的名字和 database id |
| `CF_D1_PREVIEW_DATABASE_ID` | 预览环境 D1 绑定 | Cloudflare 返回的 preview database id |
| `CF_R2_BUCKET_NAME` | 覆盖生成配置里的 R2 绑定 | 已有 R2 bucket 名称 |
| `CF_SUBREQUEST_LIMIT` | 仅在付费 Worker 下覆盖 `limits.subrequests` | `10000` |

## 3. Cloudflare 资源创建顺序

推荐优先使用 Wrangler 自动 provisioning。先登录并生成一次有效配置：

```bash
wrangler login
npm run cf:config
```

默认情况下：

- `wrangler.jsonc` 不再提交 KV / D1 / R2 的实例 ID 或名称。
- 执行 `wrangler dev` / `wrangler deploy` 时，Wrangler 会根据无 ID 绑定自动创建并关联资源。
- 自动 provisioning 过程中产生的实例信息会落在 `.wrangler/generated/wrangler.jsonc` 或 Cloudflare 侧，不需要写回仓库。

如果你必须绑定已有资源，再在 shell、CI 或 `.dev.vars` / `.env` 中提供 `CF_*` 变量后重新执行：

```bash
npm run cf:config
```

## 4. `wrangler.jsonc` 配置

当前项目把 [wrangler.jsonc](../wrangler.jsonc) 作为模板文件提交到仓库。模板中只保留绑定名，不提交资源实例信息，并启用了 `keep_vars` 以避免部署时误清空 Dashboard 已配置的 plain-text 运行时变量：

```json
{
  "keep_vars": true,
  "kv_namespaces": [
    { "binding": "KV" }
  ],
  "d1_databases": [
    { "binding": "DB", "migrations_dir": "./migrations" }
  ],
  "r2_buckets": [
    { "binding": "R2" }
  ]
}
```

执行 `npm run cf:config` 后，会生成 `.wrangler/generated/wrangler.jsonc`：

- 如果没有提供 `CF_*` 资源变量，就保持无 ID 绑定，交给 Wrangler 自动 provisioning。
- 如果提供了 `CF_*` 资源变量，脚本会把这些值写进生成文件，只在本地 / CI 生效，不污染 git 历史。

### 运行时 `vars` 字段说明

`WORKERS_PAID_ENABLED`、`R2_PUBLIC_DOMAIN`、`APP_BASE_URL`、`TELEGRAM_API_BASE` 不再在仓库模板里写死默认值。`npm run cf:config` 只会在这些值明确存在于 `.dev.vars`、`.env*`、shell / CI 环境变量时，把它们写进 `.wrangler/generated/wrangler.jsonc`。

含义如下：

| 变量 | 是否必填 | 说明 |
|---|---|---|
| `WORKERS_PAID_ENABLED` | 否 | 仅作运行时标记；代码里未设置时会按 `false` 处理 |
| `R2_PUBLIC_DOMAIN` | 否 | 配了以后媒体可生成公开 URL；不配也能上传，但链接字段可能为空 |
| `APP_BASE_URL` | 是 | OAuth 回调基地址；本地开发和线上都必须在实际运行环境里提供 |
| `TELEGRAM_API_BASE` | 否 | Telegram Bot API 基地址；未设置时使用官方 `https://api.telegram.org`，设置自建地址时媒体直发阈值按 2000MB 处理 |

这些值会被 `npm run cf:config` 从环境变量写入生成配置；如果构建期没有提供，而线上 Dashboard 里已经有运行时变量，`keep_vars` 会让 `npm run deploy` 保留这些现有值，不会被模板默认值覆盖。

## 5. 本地开发配置：`.dev.vars`

项目已经提供了模板：

- [`.dev.vars`](../.dev.vars)
- [`.dev.vars.example`](../.dev.vars.example)

本地开发时需要至少填这些值：

```dotenv
TELEGRAM_BOT_TOKEN=__YOUR_TELEGRAM_BOT_TOKEN__
TELEGRAM_API_BASE=
ADMIN_CHAT_ID=
WEBHOOK_SECRET=
WORKERS_PAID_ENABLED=false
R2_PUBLIC_DOMAIN=
APP_BASE_URL=http://localhost:8787
```

说明：

- `.dev.vars` 只给 `wrangler dev` 使用。
- `npm run cf:config` 也会读取 `.dev.vars`、`.env`、`.env.local` 以及 `CLOUDFLARE_ENV` 对应的环境文件，并且优先级低于当前 shell / CI 里的真实环境变量。
- 这里不要放真实的 X Client ID / Secret 统一配置，因为用户会在 Bot 里通过 `/setup` 提交自己的凭据。
- 如果你需要测试 OAuth 回调或 Telegram webhook，本地要配隧道地址，并把 `APP_BASE_URL` 改成公网地址。

如果你要复用已有 Cloudflare 资源，可以在同一个文件里追加：

```dotenv
CF_KV_ID=
CF_KV_PREVIEW_ID=
CF_D1_DATABASE_NAME=
CF_D1_DATABASE_ID=
CF_D1_PREVIEW_DATABASE_ID=
CF_R2_BUCKET_NAME=
CF_SUBREQUEST_LIMIT=
```

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
2. 依次输入默认的 `Client ID` 和 `Client Secret`
3. 执行 `/login`
4. 打开授权链接完成绑定
5. 如需让某个已连接 X 账号改用另一套 API 凭据，执行 `/setup <account_id>` 或 `/setup <account_id> <client_id> <client_secret>`
6. 如需让某个已连接账号重新走 OAuth，执行 `/login <account_id>`

因此：

- Worker 不保存统一的 X API 全局密钥
- `users` 表只保留用户默认的 X API 凭据，用于连接新账号
- 每个 X 账号自己的 X API 凭据、Access Token / Refresh Token 都存放在 `accounts` 表

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
如果你使用自建 Telegram Bot API，则把上面命令的 `api.telegram.org` 替换成 `tgbotapi.drkying.com`，并在 Worker 环境变量中设置 `TELEGRAM_API_BASE=https://tgbotapi.drkying.com`。

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

建表 SQL 和后续升级 SQL 都在 `migrations/` 目录中，目前至少包括：

- [migrations/0001_init.sql](../migrations/0001_init.sql)
- [migrations/0002_account_credentials_and_telegram_links.sql](../migrations/0002_account_credentials_and_telegram_links.sql)

本地和远程建议都执行一次：

```bash
npm run db:init:local
npm run db:init:remote
```

脚本内部会使用 D1 绑定名 `DB` 和 `.wrangler/generated/wrangler.jsonc`，因此不需要在仓库里硬编码数据库名称。

## 11. 推荐配置顺序

建议完全按这个顺序做：

1. `npm install`
2. `wrangler login`
3. 填写 `.dev.vars` 或 shell / CI 环境变量
4. 如需复用已有资源，补充 `CF_*` 变量
5. `npm run cf:config`
6. 执行 D1 初始化
7. 配置 X App Redirect URI
8. 配置 Worker Secrets
9. `npm run build`
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

## 13. `package.json` 自动执行的初始化

当前脚本约定如下：

```bash
npm run cf:config
```

会自动执行：

1. 读取 `wrangler.jsonc`
2. 合并 `.dev.vars` / `.env*` 与当前进程环境变量
3. 输出 `.wrangler/generated/wrangler.jsonc`

```bash
npm run build
```

会自动执行：

1. `wrangler types`
2. `tsc --noEmit`
3. 本地 D1 初始化：
   `wrangler d1 migrations apply DB --local --config .wrangler/generated/wrangler.jsonc`

```bash
npm run deploy
```

会自动执行：

1. `npm run build`
2. 如果生成配置里已经有 `DB.database_id`，先执行远程 D1 初始化：
   `wrangler d1 migrations apply DB --remote --config .wrangler/generated/wrangler.jsonc`
3. `wrangler deploy --keep-vars --config .wrangler/generated/wrangler.jsonc`
4. 部署后再兜底检查一次远程 D1 初始化：
   `wrangler d1 migrations apply DB --remote --config .wrangler/generated/wrangler.jsonc`
5. 如果生成配置里仍然没有 `database_id`，脚本会打印告警并跳过远程 migration，而不是直接让整次部署失败

## 14. Cloudflare Git 自动构建注意事项

Cloudflare Workers Builds 里有两套变量来源：

1. `Settings > Build > Build variables and secrets`
2. Worker 自己的 `Variables and secrets`

它们不是同一套，Build variables 只在构建 / 部署命令执行时可见，不会自动继承 Worker 运行时变量。

因此：

- `CF_D1_DATABASE_NAME`、`CF_D1_DATABASE_ID`、`CF_KV_ID`、`CF_KV_PREVIEW_ID`、`CF_D1_PREVIEW_DATABASE_ID`、`CF_R2_BUCKET_NAME` 这种会影响 Wrangler 绑定生成的值，如果要在 Git 自动部署里复用已有资源，必须放到 Build variables and secrets。
- `APP_BASE_URL`、`TELEGRAM_API_BASE`、`R2_PUBLIC_DOMAIN`、`WORKERS_PAID_ENABLED` 如果希望由构建时生成的 `wrangler` 配置主动覆盖线上值，也应放到 Build variables 里。
- 如果这些运行时 plain-text 变量只配置在 Worker Dashboard，而没有放到 Build variables，`npm run deploy` 会依赖 `--keep-vars` 保留它们的线上现值。
- `TELEGRAM_BOT_TOKEN`、`WEBHOOK_SECRET`、`ADMIN_CHAT_ID` 仍然属于运行时 Secret / Variable，不需要为了 `npm run build` 重复配置到 Build variables，除非你的自定义构建脚本显式读取了它们。

## 15. 生产前检查

部署前确认：

- 需要复用已有资源时，`CF_*` 变量已经设置到 shell / CI / `.env*`，或者 Cloudflare Git 的 Build variables and secrets
- `APP_BASE_URL` 已切到线上域名
- `TELEGRAM_API_BASE` 已按需配置；未配置时会使用官方 `https://api.telegram.org`
- D1 migration 已执行
- `TELEGRAM_BOT_TOKEN` 已设置
- `WEBHOOK_SECRET` 已设置或明确决定不用
- X App Redirect URI 已切到线上地址
- Telegram webhook 已指向线上 `/webhook`
- `ADMIN_CHAT_ID` 已配置

## 16. 运维建议

当前项目已开启 `wrangler.jsonc` / 生成后的有效配置中的：

```json
{
  "observability": {
    "logs": {
      "enabled": true
    }
  }
}
```

同时代码会输出结构化 JSON 日志，常见字段包括：

- `request_id`：HTTP 请求级关联 ID
- `job_id`：Cron 任务级关联 ID
- `poll_id`：单账号轮询关联 ID
- `account_id` / `tweet_id` / `chat_id`
- `duration_ms`

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
