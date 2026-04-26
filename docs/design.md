# X 点赞自动保存 Telegram Bot — 软件实施方案

> **项目目标**：部署在 Cloudflare Workers 上的 Telegram Bot，支持多用户自带 X API Key、多账号登录，自动监测点赞，推文转 Markdown 并下载媒体推送至 Telegram，数据持久化到 D1 为后续 Web 访问预留。

---

## 1. 对 Gemini 报告的修正

| 项目 | Gemini 报告 | 实际情况（2026.04） |
|---|---|---|
| X API 定价 | owned reads $0.001/条 | **按量付费**：Post Read ~$0.005/次 |
| 免费层 | 暗示有免费额度 | **无免费层**，需预充值 credits |
| Workers CPU | 未提及 | 免费层 **10ms/请求** |
| TG file_id | 未提及 | **持久有效**可重发，下载链接仅 1h |

---

## 2. 系统架构

```
Telegram 用户 → Webhook POST → Cloudflare Worker (Hono + grammY)
  ├── /webhook        → Bot 命令处理
  ├── /auth/login     → 生成 PKCE 授权链接
  ├── /auth/callback  → 换 Token → D1 存储
  └── Cron (*/5)      → 轮询 liked_tweets → 处理 → 推送 → 入库

存储层：
  KV   → OAuth 临时状态 + 轮询锁
  D1   → users / accounts / tweets / media / tweet_authors
  R2   → 视频/图片持久存储（media/{accountId}/{tweetId}/{file}）
```

### 设计原则
1. **多租户自带 Key**：用户自行输入 X API Client ID/Secret
2. **多账号隔离**：每账号独立 Token、游标、轮询配置
3. **媒体优先级**：telegram_file_id > R2 URL > X 原始 URL（兜底）
4. **轮询可配置**：每账号独立设置频率/时间段/开关

---

## 3. 技术栈

| 类别 | 选型 | 理由 |
|---|---|---|
| 运行时 | Cloudflare Workers | 免费层够用 |
| Bot | grammY + `@grammyjs/cloudflare` | 官方 CF 适配 |
| 路由 | Hono | 轻量，CF 原生 |
| 主数据库 | D1 (SQLite) | 免费 500万读/天、10万写/天、5GB |
| 临时状态 | KV | OAuth state 等短生命周期 |
| 媒体存储 | R2 | 免费 10GB，出站免费 |
| 语言 | TypeScript | 类型安全 |

---

## 4. 项目结构

```
src/
├── index.ts              # Worker 入口：Hono 路由 + Cron
├── bot.ts                # grammY 实例 + 命令注册
├── commands/
│   ├── start.ts          # /start
│   ├── setup.ts          # /setup 配置 X API Key
│   ├── login.ts          # /login 绑定账号
│   ├── accounts.ts       # /accounts 管理
│   ├── polling.ts        # /polling 轮询配置
│   └── convert.ts        # /convert 手动转换媒体
├── auth.ts               # OAuth 2.0 PKCE
├── poller.ts             # Cron 轮询
├── processor.ts          # 推文→Markdown + 媒体提取
├── sender.ts             # Telegram 发送
├── media-handler.ts      # 媒体下载 + R2 上传 + file_id
├── twitter-api.ts        # X API 封装（含 Token 刷新）
├── db.ts                 # D1 数据访问层
├── kv-store.ts           # KV 封装
└── types.ts              # 类型定义
migrations/
└── 0001_init.sql         # D1 建表
wrangler.toml
```

---

## 5. 数据库设计（D1）

### ER 关系
```
users (1) → (N) accounts (1) → (N) tweets (1) → (N) media
                                tweets (N) → (1) tweet_authors
```

### 建表 SQL

```sql
CREATE TABLE users (
    telegram_chat_id  INTEGER PRIMARY KEY,
    x_client_id       TEXT NOT NULL,
    x_client_secret   TEXT NOT NULL,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
    account_id        TEXT PRIMARY KEY,       -- X 用户 ID
    telegram_chat_id  INTEGER NOT NULL REFERENCES users(telegram_chat_id),
    username          TEXT NOT NULL,
    display_name      TEXT,
    access_token      TEXT NOT NULL,
    refresh_token     TEXT NOT NULL,
    token_expires_at  INTEGER NOT NULL,
    is_active         INTEGER DEFAULT 1,      -- 轮询开关
    poll_interval_min INTEGER DEFAULT 30,     -- 轮询间隔（分钟）
    poll_start_hour   INTEGER DEFAULT 0,      -- 开始时间 0-23
    poll_end_hour     INTEGER DEFAULT 24,     -- 结束时间 1-24
    last_poll_at      TEXT,
    last_tweet_id     TEXT,                   -- 增量游标
    created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tweet_authors (
    author_id         TEXT PRIMARY KEY,
    username          TEXT NOT NULL,
    display_name      TEXT,
    profile_url       TEXT,                   -- https://x.com/{username}
    avatar_url        TEXT,
    updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tweets (
    tweet_id          TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES accounts(account_id),
    author_id         TEXT NOT NULL REFERENCES tweet_authors(author_id),
    tweet_url         TEXT NOT NULL,
    text_raw          TEXT,
    text_markdown     TEXT,
    liked_at          TEXT,
    tweet_created_at  TEXT,
    saved_at          TEXT DEFAULT (datetime('now')),
    has_media         INTEGER DEFAULT 0,
    media_count       INTEGER DEFAULT 0
);
CREATE INDEX idx_tweets_account ON tweets(account_id);
CREATE INDEX idx_tweets_author ON tweets(author_id);
CREATE INDEX idx_tweets_saved ON tweets(saved_at);

CREATE TABLE media (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id          TEXT NOT NULL REFERENCES tweets(tweet_id),
    media_key         TEXT,
    media_type        TEXT NOT NULL,           -- photo|video|animated_gif
    telegram_file_id  TEXT,                    -- 优先级 1
    r2_key            TEXT,                    -- 优先级 2
    r2_public_url     TEXT,
    x_original_url    TEXT,                    -- 优先级 3（兜底）
    width             INTEGER,
    height            INTEGER,
    duration_ms       INTEGER,
    file_size_bytes   INTEGER,
    content_type      TEXT,
    bitrate           INTEGER,
    storage_status    TEXT DEFAULT 'pending',  -- pending|telegram|r2|x_only|failed
    created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_media_tweet ON media(tweet_id);
CREATE INDEX idx_media_status ON media(storage_status);
```

### 媒体状态流转
```
pending → telegram  （TG 发送成功，记录 file_id）
pending → r2        （R2 上传成功）
pending → x_only    （TG 和 R2 都失败）
x_only  → telegram  （用户 /convert 手动转换）
x_only  → r2        （用户 /convert 手动转换）
```

---

## 6. 核心功能实现

### 6.1 用户注册与 API Key 配置

1. `/start` → 欢迎信息 + 使用指南
2. `/setup` → Bot 进入会话模式，依次要求输入 Client ID 和 Client Secret
3. 存入 D1 `users` 表 → 提示使用 `/login`

> 每个 Telegram 用户使用自己的 X API Key，Bot 不内置任何 Key。

### 6.2 OAuth 2.0 PKCE 登录

1. `/login` → 从 D1 读取用户的 `x_client_id`
2. 生成 `code_verifier` + `code_challenge`（S256）+ 随机 `state`
3. KV 存 `auth_state:{state}`（TTL=600s）含 verifier + chat_id
4. 返回授权链接（用户自己的 client_id）
5. 回调 `/auth/callback` → 验证 state → 换 Token → `GET /2/users/me`
6. 存 D1 `accounts` 表 → 通知成功

scope：`tweet.read users.read like.read offline.access`

### 6.3 轮询配置（每账号独立）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `is_active` | 1 | 轮询开关 |
| `poll_interval_min` | 30 | 间隔（分钟） |
| `poll_start_hour` | 0 | 开始小时（UTC） |
| `poll_end_hour` | 24 | 结束小时（UTC） |

**命令**：
- `/polling list` — 查看所有账号配置
- `/polling on/off {id}` — 开关
- `/polling interval {id} {min}` — 设置间隔
- `/polling hours {id} {start}-{end}` — 设置时段

**Cron 策略**：wrangler 配置 `*/5 * * * *`（每 5 分钟触发），触发后检查每个账号：
- `is_active` 是否开启
- 当前时间是否在 `poll_start_hour` ~ `poll_end_hour` 内
- 距离 `last_poll_at` 是否超过 `poll_interval_min`
- KV 轮询锁 `polling_lock:{id}`（TTL=120s）是否存在

### 6.4 点赞轮询与入库

```
Cron 触发 → 遍历需轮询的账号：
  → 设 KV 轮询锁
  → 确保 Token 有效
  → GET /2/users/{id}/liked_tweets
      expansions=attachments.media_keys,author_id
      media.fields=variants,url,type,preview_image_url,width,height
      tweet.fields=entities,created_at,text
      user.fields=username,name,profile_image_url
  → 与 last_tweet_id 比对筛选新推文
  → 每条新推文：
      1. 写入/更新 tweet_authors
      2. 推文转 Markdown → 写入 tweets
      3. 提取媒体 → 写入 media（status=pending）
      4. 发送 Telegram → 记录 file_id（status=telegram）
      5. 上传 R2 → 记录 r2_key（status=r2）
      6. 都失败 → 保留 x_original_url（status=x_only）
  → 更新 last_tweet_id + last_poll_at
  → 释放锁
```

### 6.5 推文转 Markdown

输出格式：
```
🔖 **{displayName}** (@{username})
📅 {createdAt}

{推文正文，t.co 展开，保留 hashtag/mention}

🔗 [查看原推](https://x.com/{username}/status/{tweetId})
```

MarkdownV2 转义：`_ * [ ] ( ) ~ ` > # + - = | { } . !` 前加 `\`

### 6.6 媒体处理

| 类型 | 处理 |
|---|---|
| 图片 | sendPhoto(url) → 记录 file_id + 上传 R2 |
| 官方 Bot API 视频 ≤50MB / 自建 Bot API 视频 ≤2000MB | sendVideo(url) → 记录 file_id |
| 官方 Bot API 视频 >50MB / 自建 Bot API 视频 >2000MB | 上传 R2 并发送替换后的媒体链接 |
| 多媒体 | sendMediaGroup 相册模式 |
| GIF | sendAnimation(url) |

视频选择：`variants.filter(v => v.content_type === 'video/mp4').sort((a,b) => b.bitrate - a.bitrate)[0]`

### 6.7 手动转换（/convert）

- `/convert {tweetId}` — 转换指定推文的 x_only 媒体
- `/convert all` — 转换所有 x_only 媒体

逻辑：fetch x_original_url → 上传 R2 / 发送 TG → 更新 status

### 6.8 Token 自动刷新

- 调用前检查 `token_expires_at`，过期前 5 分钟刷新
- 使用用户自己的 `client_id` + `client_secret`
- 刷新后更新 D1
- refresh_token 失效 → 通知用户 `/login`

---

## 7. Bot 命令总览

| 命令 | 功能 |
|---|---|
| `/start` | 欢迎 + 指南 |
| `/setup` | 配置 X API Key |
| `/login` | 绑定 X 账号 |
| `/accounts` | 查看已绑定账号 |
| `/remove {id}` | 解绑账号 |
| `/polling list` | 查看轮询配置 |
| `/polling on/off {id}` | 开关轮询 |
| `/polling interval {id} {min}` | 设置间隔 |
| `/polling hours {id} {s}-{e}` | 设置时段 |
| `/convert {tweetId\|all}` | 转换 x_only 媒体 |
| `/status` | 系统状态 |

---

## 8. wrangler.toml

```toml
name = "x-like-save-bot"
main = "src/index.ts"
compatibility_date = "2026-04-22"

[triggers]
crons = ["*/5 * * * *"]

[[kv_namespaces]]
binding = "KV"
id = "<KV_ID>"

[[d1_databases]]
binding = "DB"
database_name = "CF_D1_DATABASE_NAME_REMOVED"
database_id = "<D1_ID>"

[[r2_buckets]]
binding = "R2"
bucket_name = "CF_R2_BUCKET_NAME_REMOVED"

[vars]
WORKERS_PAID_ENABLED = "false"
R2_PUBLIC_DOMAIN = ""
```

Secrets（`wrangler secret put`）：`TELEGRAM_BOT_TOKEN`、`ADMIN_CHAT_ID`（可选）、`WEBHOOK_SECRET`（可选）

---

## 9. 部署流程

```bash
npm install grammy hono
npm install -D wrangler typescript @cloudflare/workers-types

wrangler kv namespace create "KV"
wrangler d1 create "CF_D1_DATABASE_NAME_REMOVED"
wrangler r2 bucket create "CF_R2_BUCKET_NAME_REMOVED"
# 填入 wrangler.toml

wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --file=migrations/0001_init.sql
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler dev          # 本地测试
wrangler deploy       # 部署

# 设置 Webhook
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<URL>/webhook"
```

---

## 10. 容错

| 错误 | 处理 |
|---|---|
| Token 过期 | 自动 refresh（用户自己的 key） |
| refresh_token 失效 | 通知用户 `/login` |
| X API 429 | 指数退避重试 ×3 |
| X API 5xx | 跳过本次 |
| TG 发送失败 | 重试 3 次 → storage_status=x_only |
| R2 失败 | 不影响 TG，跳过 R2 |
| D1 写入失败 | 通知管理员 |
| 未配置 API Key | 提示 `/setup` |
| 轮询并发 | KV 锁（TTL=120s） |

监控：错误发到 ADMIN_CHAT_ID + Cloudflare Dashboard + `wrangler tail`

---

## 11. 成本估算（2 账号，30min 轮询）

| 项目 | 免费额度 | 月成本 |
|---|---|---|
| Workers | 10 万请求/天 | $0 |
| KV | 10 万读/天 | $0 |
| D1 | 500 万读/天 | $0 |
| R2 | 10GB + 出站免费 | $0 |
| X API | 按量付费 | **~$14** |
| Workers Paid（可选） | — | $0-5 |
| **总计** | | **$14-19/月** |

降低成本：延长轮询间隔 / 仅活跃时段轮询 / 智能间隔调整

---

## 12. 后续扩展预留（Web 访问）

数据模型已支持：

| 访问方式 | 查询 |
|---|---|
| 按时间线 | `tweets ORDER BY saved_at DESC` + 分页 |
| 按发推人 | `tweet_authors` JOIN `tweets` 按 author_id |
| 搜索 | `tweets.text_raw LIKE` 或后续 FTS |
| 媒体预览 | `media.r2_public_url` / `telegram_file_id` |

可通过 Cloudflare Pages 搭建前端，直接绑定同一 D1。
