# X 点赞自动保存 Telegram Bot — 开发检查清单

> 按开发流程排列，每完成一项打 ✅，确保无遗漏。

---

## 阶段一：前置准备

### 1.1 账号与服务注册
- [ ] 注册 Cloudflare 账号，开通 Workers
- [ ] @BotFather 创建 Telegram Bot，记录 Bot Token
- [ ] 获取管理员 Telegram Chat ID（@userinfobot）
- [ ] 注册 X Developer 账号 (https://developer.x.com/)
- [ ] 创建 X Developer Project + App
- [ ] 开启 OAuth 2.0（User Authentication Settings）
- [ ] 设置 App permissions: Read（tweet.read, users.read, like.read）
- [ ] 设置 Redirect URI 为 Worker 的 `/auth/callback` 地址
- [ ] 获取 Client ID 和 Client Secret
- [ ] 预充值 X API credits

### 1.2 开发环境
- [ ] 安装 Node.js ≥18
- [ ] 安装 Wrangler CLI（`npm install -g wrangler`）
- [ ] `wrangler login` 登录 Cloudflare
- [ ] 安装 TypeScript

---

## 阶段二：项目初始化

### 2.1 项目结构
- [ ] 创建项目目录
- [ ] `npm init -y`
- [ ] 安装依赖：`grammy`、`hono`
- [ ] 安装开发依赖：`wrangler`、`typescript`、`@cloudflare/workers-types`
- [ ] 创建 `tsconfig.json`（target: ESNext, module: ESNext）
- [ ] 创建 `wrangler.toml`
- [ ] 创建 `.dev.vars`（本地环境变量）
- [ ] 创建 `.gitignore`（排除 node_modules、.dev.vars、.wrangler）
- [ ] 创建 `src/` 目录及所有模块文件
- [ ] 创建 `migrations/0001_init.sql`

### 2.2 Cloudflare 资源
- [ ] `wrangler kv namespace create "KV"` → 填入 wrangler.toml
- [ ] `wrangler kv namespace create "KV" --preview` → 填入 preview_id
- [ ] `wrangler d1 create "CF_D1_DATABASE_NAME_REMOVED"` → 填入 wrangler.toml
- [ ] `wrangler r2 bucket create "CF_R2_BUCKET_NAME_REMOVED"`
- [ ] R2 bucket 配置公开访问域名（可选，后续 Web 用）

### 2.3 Secrets
- [ ] `wrangler secret put TELEGRAM_BOT_TOKEN`
- [ ] `wrangler secret put ADMIN_CHAT_ID`（可选）
- [ ] `.dev.vars` 中配置本地开发用的相同变量

### 2.4 数据库初始化
- [ ] 编写 `migrations/0001_init.sql`（5 张表 + 索引）
- [ ] `wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --file=migrations/0001_init.sql`
- [ ] 本地 `wrangler d1 execute CF_D1_DATABASE_NAME_REMOVED --local --file=migrations/0001_init.sql`

---

## 阶段三：核心功能开发

### 3.1 类型定义（types.ts）
- [ ] `Env` 类型（KV、DB、R2 binding + 环境变量 + secrets）
- [ ] `AccountData` 接口（含轮询配置字段）
- [ ] `UserData` 接口（telegram_chat_id + x_client_id/secret）
- [ ] `TweetRecord` / `MediaRecord` / `TweetAuthor` 接口
- [ ] X API 响应类型（Tweet、Media、User、MediaVariant）
- [ ] `AuthState` 接口（code_verifier + telegram_chat_id）

### 3.2 KV 封装（kv-store.ts）
- [ ] `setAuthState(state, data, ttl)` — OAuth 临时状态
- [ ] `getAuthState(state)` — 读取临时状态
- [ ] `setPollingLock(accountId, ttl)` — 设置轮询锁
- [ ] `getPollingLock(accountId)` — 检查轮询锁
- [ ] `deletePollingLock(accountId)` — 释放锁

### 3.3 D1 数据访问层（db.ts）
- [ ] **users 表**：getUser / createUser / updateUser
- [ ] **accounts 表**：getAccount / createAccount / updateAccount / deleteAccount / listAccountsByUser / listActiveAccounts
- [ ] **tweet_authors 表**：upsertAuthor / getAuthor
- [ ] **tweets 表**：createTweet / getTweet / listTweetsByAccount / listTweetsByAuthor / searchTweets
- [ ] **media 表**：createMedia / updateMediaStatus / getMediaByTweet / listMediaByStatus

### 3.4 X API 封装（twitter-api.ts）
- [ ] `generatePKCE()` — code_verifier + code_challenge
- [ ] `buildAuthUrl(clientId, redirectUri, state, challenge)` — 授权 URL
- [ ] `exchangeCodeForToken(code, verifier, clientId, clientSecret)` — 换 Token
- [ ] `refreshAccessToken(refreshToken, clientId, clientSecret)` — 刷新 Token
- [ ] `ensureValidToken(account, user, db)` — 自动检查 + 刷新
- [ ] `getUserMe(accessToken)` — 获取当前用户信息
- [ ] `getLikedTweets(userId, accessToken, options)` — 获取点赞列表
- [ ] 正确的 expansions + fields 参数
- [ ] 错误处理：401、403、429、5xx

### 3.5 OAuth 认证（auth.ts）
- [ ] `/auth/login` 路由：生成 PKCE → 存 KV → 返回授权链接
- [ ] `/auth/callback` 路由：验证 state → 换 Token → 存 D1 → 通知用户
- [ ] state 验证防 CSRF
- [ ] 处理授权失败/拒绝
- [ ] 同一用户可多次 /login 绑定不同账号
- [ ] OAuth scope 包含 `offline.access`
- [ ] 使用用户自己的 client_id/secret（从 D1 读取）

### 3.6 推文处理（processor.ts）
- [ ] `tweetToMarkdown(tweet, includes)` — 转 Markdown
- [ ] 展开 t.co 短链
- [ ] 保留 Hashtag 和 Mention
- [ ] MarkdownV2 转义（所有特殊字符）
- [ ] 格式含：作者名/用户名/时间/正文/原推链接
- [ ] `extractMedia(tweet, includes)` — 提取媒体信息
- [ ] 图片：`media.url`
- [ ] 视频：最高 bitrate 的 mp4
- [ ] GIF：识别 `animated_gif` 类型

### 3.7 媒体处理（media-handler.ts）
- [ ] `uploadToR2(env, key, stream, contentType)` — R2 上传
- [ ] `getR2PublicUrl(env, key)` — 生成公开 URL
- [ ] `processMediaItem(env, mediaItem)` — 单个媒体完整处理流程
- [ ] 图片：fetch → R2 上传
- [ ] 视频：检查大小 → R2 上传
- [ ] storage_status 正确流转

### 3.8 Telegram 发送（sender.ts）
- [ ] 纯文本推文：`sendMessage` with MarkdownV2
- [ ] 单图片：`sendPhoto` with caption
- [ ] 单视频 ≤50MB：`sendVideo` with caption
- [ ] 单视频 >50MB：ReadableStream 流式代理上传
- [ ] 多媒体：`sendMediaGroup` 相册模式
- [ ] GIF：`sendAnimation`
- [ ] 发送后提取并记录 file_id 到 D1
- [ ] 重试机制（最多 3 次）
- [ ] `notifyAdmin(message)` — 管理员通知
- [ ] `notifyUser(chatId, message)` — 用户通知

### 3.9 轮询逻辑（poller.ts）
- [ ] `pollAllAccounts(env)` — 遍历所有需轮询的账号
- [ ] 检查 `is_active`，跳过已暂停
- [ ] 检查当前时间是否在 `poll_start_hour` ~ `poll_end_hour` 内
- [ ] 检查距 `last_poll_at` 是否超过 `poll_interval_min`
- [ ] 设置 KV 轮询锁（TTL=120s）
- [ ] Token 过期自动刷新（用户自己的 key）
- [ ] 新推文按时间顺序（旧→新）处理
- [ ] 每条推文：写 tweet_authors → 写 tweets → 写 media → 发 TG → 上传 R2
- [ ] 更新 `last_tweet_id` + `last_poll_at`
- [ ] 单账号失败不影响其他账号
- [ ] 释放轮询锁
- [ ] 指数退避重试（API 限流时）

### 3.10 Bot 命令（bot.ts + commands/）
- [ ] `/start` — 欢迎信息 + 使用指南
- [ ] `/setup` — 会话模式输入 Client ID + Secret → 存 D1
- [ ] `/login` — 触发 OAuth 流程
- [ ] `/accounts` — 列出已绑定账号
- [ ] `/remove {id}` — 解绑账号
- [ ] `/polling list` — 查看所有轮询配置
- [ ] `/polling on {id}` — 开启轮询
- [ ] `/polling off {id}` — 关闭轮询
- [ ] `/polling interval {id} {min}` — 设置间隔
- [ ] `/polling hours {id} {start}-{end}` — 设置时段
- [ ] `/convert {tweetId}` — 转换指定推文的 x_only 媒体
- [ ] `/convert all` — 转换所有 x_only 媒体
- [ ] `/status` — 系统状态
- [ ] 无效命令友好提示

### 3.11 Worker 入口（index.ts）
- [ ] Hono 路由：`/webhook`、`/auth/login`、`/auth/callback`
- [ ] export `fetch` handler
- [ ] export `scheduled` handler（Cron 触发）
- [ ] grammY `webhookCallback` 与 Hono 集成
- [ ] Cron 中调用 `pollAllAccounts(env)`
- [ ] 全局错误捕获 + 管理员通知
- [ ] `WORKERS_PAID_ENABLED` 环境变量检查

---

## 阶段四：安全性检查

- [ ] Bot Token 使用 Secrets，不硬编码
- [ ] `.dev.vars` 在 `.gitignore` 中
- [ ] 用户的 X Client Secret 存 D1，不暴露给前端
- [ ] OAuth state 验证防 CSRF
- [ ] KV auth_state 设置 TTL=600s
- [ ] refresh_token 仅存服务端（D1）
- [ ] Webhook secret token 验证（可选）
- [ ] `/setup` 命令中 Client Secret 消息提示用户删除聊天记录

---

## 阶段五：本地测试

- [ ] `wrangler dev` 启动成功
- [ ] `/start` 返回欢迎信息
- [ ] `/setup` 会话模式输入 API Key 正常存储
- [ ] `/login` 生成正确授权链接（用户自己的 client_id）
- [ ] OAuth 回调流程完整（需 ngrok 暴露本地端口）
- [ ] Token 存储到 D1 正确
- [ ] `wrangler dev --test-scheduled` 手动触发 Cron
- [ ] 轮询逻辑：获取新点赞、跳过已处理
- [ ] 轮询配置生效：interval / hours / on|off
- [ ] Markdown 转换输出格式正确
- [ ] MarkdownV2 转义无语法错误
- [ ] 图片发送到 Telegram + file_id 记录到 D1
- [ ] 视频发送到 Telegram + file_id 记录到 D1
- [ ] 媒体上传到 R2 + r2_key 记录到 D1
- [ ] sendMediaGroup 相册模式正常
- [ ] 多账号独立轮询
- [ ] Token 刷新逻辑
- [ ] `/convert` 命令正常工作
- [ ] 错误场景：无效 Token、API 超时、TG 发送失败
- [ ] 轮询锁防并发

---

## 阶段六：部署

- [ ] `wrangler deploy`
- [ ] 记录 Worker URL
- [ ] 设置 Telegram Webhook（`setWebhook`）
- [ ] `getWebhookInfo` 验证设置成功
- [ ] 更新 X App Redirect URI 为生产 URL
- [ ] Cloudflare Dashboard 中 Cron Trigger 显示正确
- [ ] D1 生产数据库已执行迁移

---

## 阶段七：上线后验证

### 7.1 功能验证
- [ ] `/start` 收到欢迎信息
- [ ] `/setup` 输入 API Key 成功
- [ ] `/login` 收到授权链接
- [ ] 完成授权，收到登录成功通知
- [ ] `/accounts` 显示已绑定账号
- [ ] 点赞纯文本推文 → ≤30min 收到 TG 通知
- [ ] 点赞含图推文 → 图片正确推送 + file_id 入库
- [ ] 点赞含视频推文 → 视频正确推送 + file_id 入库
- [ ] 点赞多图推文 → 相册模式正确
- [ ] 绑定第二个 X 账号 → 独立工作
- [ ] `/polling` 命令系列正常
- [ ] `/convert` 转换 x_only 媒体成功
- [ ] `/remove` 解绑账号

### 7.2 数据验证
- [ ] D1 `tweets` 表记录完整（text_raw、text_markdown、tweet_url）
- [ ] D1 `tweet_authors` 表包含 profile_url
- [ ] D1 `media` 表 storage_status 正确
- [ ] R2 中媒体文件可通过公开 URL 访问
- [ ] telegram_file_id 可用于重发消息

### 7.3 稳定性验证
- [ ] 连续运行 24 小时无报错
- [ ] Token 自动刷新正常（~2h 后验证）
- [ ] 游标机制无重复推送
- [ ] CPU 用时在限制内（Dashboard 查看）
- [ ] D1/KV/R2 用量在免费额度内

### 7.4 监控确认
- [ ] 错误通知发到管理员 Chat ID
- [ ] Cloudflare Dashboard 可见统计
- [ ] `wrangler tail` 可查实时日志

---

## 阶段八：文档与维护

- [ ] README.md：项目说明、部署步骤、使用方法
- [ ] 环境变量和 Secrets 说明文档
- [ ] X API credits 消耗监控提醒
- [ ] 定期检查：月成本、日志、Token 状态、R2 存储用量
- [ ] D1 数据库备份策略（Time Travel 7 天）
