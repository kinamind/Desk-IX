# Telegram 接入

## 1. 创建 Bot 与取得 user ID

1. 在 Telegram 中联系 `@BotFather`，执行 `/newbot`，保存 Bot Token。
2. 取得自己的数字 user ID；可使用 Telegram 官方 `getUpdates` 返回中的 `message.from.id`，或可信的 user-info bot。
3. 生成 webhook secret：

```bash
openssl rand -hex 32
```

Secret 只能使用 Telegram 接受的 `A-Z a-z 0-9 _ -` 字符；十六进制满足要求。

## 2. 配置 Desk-IX

在 Cloudflare Dashboard 的 **Variables and secrets** 中设置：

```jsonc
"TELEGRAM_ALLOWED_USER_IDS": "123456789"
```

多个个人账号用逗号分隔。不要加入陌生 user ID。

部署 Worker 后写入 secrets：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

每条命令会安全提示输入；不要把真实值写进仓库或提交到 Git。

## 3. 设置 webhook

Webhook 地址是：

```text
https://desk-ix.kinamind.org/webhooks/telegram
```

脚本从环境变量读取 token/secret，不会把它们打印到输出。为避免 shell history 留下明文，可交互读取：

```bash
export DESK_IX_URL="https://desk-ix.kinamind.org"
read -s TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
read -s TELEGRAM_WEBHOOK_SECRET && export TELEGRAM_WEBHOOK_SECRET
npm run telegram:webhook
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
```

脚本会订阅 `message`、`edited_message`、`callback_query` 并设置 `secret_token`。

验证 Telegram 状态：

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

不要把含 Token 的 URL 放到公开日志或截图中。

## 4. 验收

按顺序发送：

```text
想到一个 idea：研究 Agent communication 与团队 mind flow
2 小时后提醒我测试 Desk-IX
我最近有哪些 research ideas？
```

预期分别得到简短记录、提醒确认和真实 D1 查询结果。非 allowlist 用户会收到 HTTP 403，事件不会进入业务处理器。

## 常见问题

- `403`：检查 Telegram webhook secret 与 user ID allowlist。
- 没有主动提醒：检查 Workflow 记录、Bot 是否被用户拉黑，以及 Cloudflare 日志。
- callback 超时但操作已完成：Telegram ack 失败不等于 D1 写入失败；用 `/api/items/:id` 或 D1 核对。
- 本地 webhook：Telegram 需要公网 HTTPS；本地开发建议用构造请求/自动测试，不在 MVP 内引入 Tunnel。
