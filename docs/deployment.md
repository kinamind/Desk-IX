# Cloudflare 部署指南

## 前置条件

- Node.js 22+
- Cloudflare 账号已能使用 Workers、D1、Workflows 与 Cron Triggers
- `npx wrangler login` 已完成，或 CI 环境提供受限 Cloudflare API Token

确认账号：

```bash
npx wrangler whoami
```

## 1. 安装并验证本地构建

```bash
npm ci
npm run check
npm run deploy:dry
```

## 2. 创建 D1

只需创建一次：

```bash
npx wrangler d1 create composa
```

将输出的 `database_id` 替换进 `wrangler.jsonc`。不要修改 binding 名 `DB` 或 `database_name`。

应用版本化 migration：

```bash
npm run db:migrate:remote
```

可检查表：

```bash
npx wrangler d1 execute composa --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 3. 设置非敏感配置

在 Cloudflare Dashboard 的 **Variables and secrets** 中设置实例专属值：

- `TIMEZONE`、`DAILY_PLAN_TIME`
- `TELEGRAM_ALLOWED_USER_IDS`
- `QQ_APP_ID`、`QQ_ALLOWED_USER_OPENIDS`
- `DAILY_PLAN_TARGETS`
- AI endpoint/model/budget

`wrangler.jsonc` 开启了 `keep_vars`，后续运行 `npm run deploy` 会保留这些面板值，不会用仓库中的空占位覆盖它们。

首次不知道 QQ openid 时先保持 QQ allowlist 与 QQ Daily Plan target 为空，按 [QQ 接入指南](qq.md) 的一次性日志流程取得。

## 4. 首次部署与 secrets

先部署无 credential 的 Worker：

```bash
npm run deploy
```

然后按使用的通道写 secret；未使用的通道可以暂不设置：

```bash
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put AI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put QQ_APP_SECRET
```

`AI_API_KEY` 可以不设置，但除 `/help` 和按钮 callback 外的自然语言理解会明确提示不可用且不会擅自保存。Composa 不会选择任何未经配置的付费 fallback。

Secret 更新后检查部署与健康状态：

```bash
export COMPOSA_URL="https://<worker-host>"
npm run smoke
```

健康响应把 AI 区分为 `configured`（Key、模型已配置）和 `verified`（当天至少一次成功调用），不会返回 secret。

## 5. 接通平台 webhook

- Telegram：见 [telegram.md](telegram.md)，运行 `npm run telegram:webhook`。
- QQ：见 [qq.md](qq.md)，在开放平台粘贴 `/webhooks/qq` 地址并订阅事件。

## 6. 部署后验收

在已授权聊天账号执行：

1. 保存公开 URL，确认回复使用网页标题，并用关键词查询。
2. 保存 Research Idea，确认没有自动生成研究方案。
3. 用口语建一个几分钟后的临时提醒，确认回复同时显示事项时间、模型选择的提前量和实际提醒时间，并验证主动推送与 `Done/Later/Reschedule`。
4. 建 deadline project，检查 `reminders` 只有至多三条 future milestones。
5. 用 `/api/daily-plan` 预览真实 D1 计划。
6. 用非 allowlist 账号验证被拒绝。
7. 再次 `npm run deploy`，确认 D1 item 与 Workflow reminder 未丢失。

查看 D1：

```bash
npx wrangler d1 execute composa --remote --command "SELECT type,title,status,due_at FROM items ORDER BY created_at DESC LIMIT 20"
```

查看实时日志：

```bash
npx wrangler tail composa --format pretty
```

## 更新流程

```bash
npm ci
npm run check
npm run db:backup
npm run db:migrate:remote
npm run deploy
npm run smoke
```

Migration 只能向前新增新版本文件；不要修改已在远端应用的历史 migration。
