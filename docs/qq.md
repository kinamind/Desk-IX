# QQ Bot 接入

Desk-IX 实现的是 QQ 开放平台 HTTP Webhook + C2C 私聊通道，包括官方 Ed25519 challenge/验签、单聊收发、interaction callback、主动提醒和自定义 keyboard。

## 1. 创建与授权

1. 在 QQ 开放平台创建机器人，取得 `App ID` 和 `AppSecret`。
2. 开启单聊消息能力，并订阅 `C2C_MESSAGE_CREATE`。
3. 如要使用按钮，订阅 `INTERACTION_CREATE` 并申请自定义 keyboard/消息交互权限。
4. 确认机器人具备 C2C 主动消息授权。提醒和 Daily Plan 没有原消息 `msg_id`，会消耗/受限于平台的主动消息资格与频率规则。

QQ 权限和配额由开放平台控制；Desk-IX 只做有限重试，不会绕过平台限制。

## 2. 配置 App 与 secrets

在 Cloudflare Dashboard 的 **Variables and secrets** 中设置：

```jsonc
"QQ_APP_ID": "你的 App ID",
"QQ_ALLOWED_USER_OPENIDS": "你的 user_openid"
```

写入 Cloudflare secrets：

```bash
npx wrangler secret put QQ_APP_SECRET
```

QQ 后台只提供一个 `AppSecret`。Desk-IX 同时用它完成 Ed25519 Webhook 签名和 App Access Token 获取；QQ token 接口请求体中的字段名虽然叫 `clientSecret`，值仍然就是这个 `AppSecret`。

## 3. 第一次取得自己的 `user_openid`

如果平台后台尚未显示 openid：

1. 暂时保持 `QQ_ALLOWED_USER_OPENIDS` 为空并部署。
2. 另开终端运行：

```bash
npx wrangler tail composa --format pretty
```

3. 给机器人发一条私聊。
4. 在经过 QQ 正式签名验证后的 `qq_user_not_allowlisted` JSON 日志中复制 `userId`。
5. 立即把它写入 `QQ_ALLOWED_USER_OPENIDS` 并重新部署。

空 allowlist 期间所有普通用户事件都会被拒绝；日志不会包含 AppSecret 或 Access Token。

## 4. 配置 Webhook

在 QQ 开放平台设置 HTTPS 回调：

```text
https://desk.kinamind.org/webhooks/qq
```

平台会发送 `op=13` 验证请求。Desk-IX 会：

1. 校验 `X-Bot-Appid`；
2. 将 `AppSecret` repeat 后截取 32-byte seed；
3. 对 `event_ts + plain_token` 做 Ed25519 签名；
4. 返回十六进制 `signature`。

正式事件会先验证 `X-Signature-Ed25519` 对 `X-Signature-Timestamp + raw_body` 的签名，再解析 JSON 和检查 `user_openid`。自动化测试包含 QQ 官方 challenge 向量。

## 5. 消息与按钮行为

- 收消息：`C2C_MESSAGE_CREATE`，使用 `message id + msg_idx` 去重。
- 分享卡片：合并 `ark_data.prompt`、隐藏 fields 与附件文本；其中出现正常 HTTP(S) URL 时继续调用网页阅读工具。若平台只给内部卡片 ID/小程序 scheme，则保留并理解预览内容，但不会猜造公开网址。
- 回复：`POST /v2/users/{user_openid}/messages`；即时回复携带原 `msg_id`。
- 主动提醒：同一 endpoint，不携带原 `msg_id`，因此依赖主动消息授权。
- 每日安排：首次普通对话会自动创建个人档案并启用；直接告诉 Desk-IX “每天 11 点发安排”“我在东京”“暂停每日安排”即可修改。
- 按钮：发送自定义 keyboard，data 与 Telegram 共用 `done/later/reschedule/details` 协议。
- 回调：`INTERACTION_CREATE`，处理后 `PUT /interactions/{id}` ack。
- 如果账号没有自定义 keyboard 权限，Desk-IX 在 QQ 返回 400/403 后自动再发一次纯文本，提醒本身不会因此丢失。

## 常见问题

- challenge 失败：确认回调指向当前 Worker、`QQ_APP_ID` 与 `QQ_APP_SECRET` 属于同一个机器人。
- 收到 403：查看 allowlist；不要把 QQ 号当作 `user_openid`。
- 普通回复成功、定时提醒失败：通常是主动消息授权/配额，而不是 Workflow 时间问题。
- 按钮不显示：申请 keyboard 权限；Desk-IX 会退化为纯文本，仍可发自然语言操作。
- `QQBot` token 错误：确认 `QQ_APP_SECRET`；Access Token 由 Worker 临时获取，不持久化、不记录日志。
- 卡片能保存但读不到原网页：检查 QQ 回调是否提供正常 HTTP(S) 跳转地址；内部卡片 ID 无法可靠反推出公开 URL。
