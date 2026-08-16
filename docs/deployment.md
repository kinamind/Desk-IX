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

1. 发送一个公开文章/论文链接并指定关注点，确认模型在决定回复或保存前已经看到网页正文，回答围绕该关注点而不是只保存标题。
2. 一次发送两至三个公开招聘页面，确认回复给出具体标题、机构/岗位、当地时区截止时间和实际读取来源数；再按机构、岗位或“哪些快截止”查询，答案应使用结构化事实而不是只列裸链接。无法读取的页面必须诚实显示为部分结果，不能补猜。
3. 发送两篇普通文章并要求比较，确认两个页面各读取一次，回答覆盖两个来源且没有套招聘模板。
4. 保存 Research Idea，确认没有自动生成研究方案。
5. 用口语建一个稍后处理的任务，确认模型没有选择当前时间，回复分别显示提醒时间与截止时间，并验证主动推送与“完成/稍后/改期/舍弃”。
6. 建一个带远期截止的 project，确认只安排模型明确选择的提醒，不会机械产生 30/7/1 天三个里程碑。
7. 在当前提醒附近告诉它“这个时间有事，晚一点再提醒我”，确认它修改原事项而不是新建重复待办，取消旧提醒，并将新提醒放到冲突窗口之后。
8. 紧接着说“刚才那个已经完成了”，确认原事项变为 completed、待提醒取消，并且没有生成重复记录。
9. 新建两条临时事项，再用一句话完成一条、舍弃另一条；随后用自然语言恢复舍弃项。
10. 发一句普通追问或闲聊，确认正常回复且不会自动写成 note/task。
11. 用两个不同授权身份分别预览 Daily Plan，确认不会混入另一身份的事项。
12. 用非 allowlist 账号验证被拒绝。
13. 再次 `npm run deploy`，确认 D1 item 与 Workflow reminder 未丢失。

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
