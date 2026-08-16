# 架构说明

## 设计原则

Composa 是单 Worker、单业务处理器、单 D1 数据源的 IM-first Agent。设计优先级依次是稳定、低维护、低成本和安静的交互体验。

关键边界：**LLM understands; code executes.**

- LLM 是带上下文的决策层。它读取当前用户的近期 D1 事项，判断本轮应回复、查询、分析，还是规划一个或多个 `create / complete / archive / restore / update / set_reminder` 动作。
- 代码校验结构化行动计划、核对目标事项归属，再处理 CRUD、时间合法性、回调、去重、提醒、重试与调度。模型不能直接写库或调用网络。
- `/help` 与平台 callback 不需要模型。其他自然语言在 AI 未配置、超过预算或暂时失败时会明确提示且不擅自保存，不会静默伪装成已经理解，也不会选择另一个付费模型。

## 请求链路

1. `/webhooks/telegram` 或 `/webhooks/qq` 验证平台身份。
2. Channel Adapter 检查个人 allowlist，并归一化为 `IncomingMessage`。
3. HTTP 请求尽快返回；实际处理进入 `ctx.waitUntil()`。
4. `messages` 表用 `(channel, source_message_id)` 抢占事件，重复事件直接结束。
5. 除 `/help` 外，业务层先读取当前通道、当前用户的近期事项、待发送提醒、日程窗口与最近几轮已处理对话，再调用 AI 输出结构化行动计划；历史只用于事实、指代和空闲时间，不会重复执行。小歧义由模型做可逆判断，只有多个目标同样合理且误操作代价明显时才追问。
6. 业务层先验证全部目标 id 和用户归属，再执行确定性工具。完成与舍弃会取消未发送提醒；舍弃是可恢复的 `archived` 状态，不做物理删除。发现 URL 后调用基础网页阅读工具，有界提取标题、来源和正文，再做 AI enrichment。
7. 需要提醒时先写 `reminders`，再以确定性 ID 创建 Workflow。
8. 回复通过来源 Channel Adapter 发出，最后将 message 标记为 processed。

## 数据模型

- `items`：resource、idea、task、note、project 的统一对象。`raw_message` 永远保留；`ai_enrichment` 与用户原文分开；`source_action_index` 允许一条消息安全地产生多项记录。
- `reminders`：提醒时间、目标通道、Workflow ID、发送状态和 receipt。
- `messages`：最小必要原始事件、处理状态、错误、响应和关联 item，用于去重与诊断。
- `pending_actions`：`Reschedule` 后的短期会话状态，默认 30 分钟。
- `daily_plan_runs`：按当地日期 + 通道 + 用户去重，并允许 failed 重试。
- `ai_usage`：每日 provider 请求数和 token 统计，用于硬预算。

Schema 保持少表、JSON enrichment、必要索引；D1 是 source of truth，聊天平台和未来 Calendar 都不是。

## 提醒可靠性

```text
写 reminder(pending)
  → 创建 Workflow(reminder-<uuid>)
  → sleepUntil(remind_at)
  → 重新读取 D1
  → 已完成/取消则退出
  → adapter.send()
  → 保存可序列化 receipt
  → reminder = triggered
```

Workflow 的发送与最终 D1 状态是两个 durable step。发送 step 成功后其 receipt 会被缓存；即使后续状态写入重试，也不会再次发送。创建或运行 Workflow 的错误会把 reminder 标记 failed。若实例启动时提醒时间刚刚过去，Workflow 会直接进入幂等发送步骤，不再用过去时间调用 sleep。

用户发送可行动事项时，默认语义是“现在暂存、稍后再做”。模型会区分 deferred action、pre-event、deadline 与明确的 immediate request；deferred action 至少晚于当前时间 30 分钟，深夜优先选择次日白天。代码拒绝近乎立即或晚于截止时间的结果，并让模型重新选择一次。

新建、修改或通过按钮延后提醒时，代码会从 D1 读取同一通道、同一用户未来 14 天内的开放事项和待发送提醒。事项默认占用“时间前 15 分钟至时间后 60 分钟”；若模型提取到预计时长则使用该时长，提醒占用 15 分钟。若本轮消息新透露“2:30 有事”而库中还没有，模型会把它作为临时避让窗口；未给时长时按 1 小时，并包含开始前 15 分钟缓冲。撞期的提醒以 15 分钟为粒度顺延到冲突结束后 15 分钟，并在回复中显示最终时间；若截止前没有空档，保留原提醒并明确告知。

这些窗口严格按 `channel + user_id` 查询，不会读取其他人的记录。目前 D1 是唯一日程来源，尚未接入 Google Calendar 等外部日历。

## Daily Plan

Cron 每 15 分钟运行一次，因为 Cron 使用 UTC，而业务时间可配置为任意 IANA timezone。代码比较当地 `HH:mm`，并通过 `daily_plan_runs` 保证每个目标每天最多成功一次。计划只读取真实 D1 item；AI 不可用时仍输出 `Must / Should / If time`。

## 双通道边界

核心层只认识 `ChannelAdapter`、`IncomingMessage`、`OutgoingMessage` 和 `ChannelTarget`。

- Telegram：secret token、user ID allowlist、update/callback 归一化、inline keyboard。
- QQ：App ID、官方 Ed25519 challenge/验签、`user_openid` allowlist、C2C message、interaction ack、自定义 keyboard；没有 keyboard 权限时自动退化为纯文本。

## 安全与成本

- 所有 SQL 都使用 `prepare().bind()`。
- Admin API 与 Telegram secret 使用恒定时间摘要比较。
- QQ 对 raw body 做 Ed25519 验签，并在签 challenge 前校验 App ID。
- 网页阅读工具只接受公开 HTTP(S) 字面地址，手动验证每次 redirect，限制 timeout/content-type/bytes；不绕过登录、验证码或反爬。DNS rebinding 仍属于平台网络层边界，不把网页内容当可信输入。
- 外部请求只对网络错误、429、5xx 做有限重试；永久 4xx 不重试。
- 日志按 JSON 输出，并递归遮盖 key 名中含 token、secret、authorization、api key 的字段。
- Worker 模块顶层没有可变请求状态；异步工作全部 `await` 或交给 `waitUntil()`。
