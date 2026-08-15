# 架构说明

## 设计原则

Composa 是单 Worker、单业务处理器、单 D1 数据源的 IM-first Agent。设计优先级依次是稳定、低维护、低成本和安静的交互体验。

关键边界：**LLM understands; code executes.**

- LLM 只处理模糊意图、字段抽取、网页摘要、Daily Plan 排序和明确要求的分析。
- 代码处理权限、CRUD、日期、查询、回调、去重、提醒、重试与调度。
- 没有 API Key、超过日预算或 AI 暂时不可用时，系统退化为确定性路由和忠实 note，而不是选择另一个付费模型。

## 请求链路

1. `/webhooks/telegram` 或 `/webhooks/qq` 验证平台身份。
2. Channel Adapter 检查个人 allowlist，并归一化为 `IncomingMessage`。
3. HTTP 请求尽快返回；实际处理进入 `ctx.waitUntil()`。
4. `messages` 表用 `(channel, source_message_id)` 抢占事件，重复事件直接结束。
5. 先匹配确定性意图；只有不明确时才调用一次 AI structured output。
6. 业务层写 D1；Resource 永远先保存原始消息/URL，再 best-effort 抓网页。
7. 需要提醒时先写 `reminders`，再以确定性 ID 创建 Workflow。
8. 回复通过来源 Channel Adapter 发出，最后将 message 标记为 processed。

## 数据模型

- `items`：resource、idea、task、note、project 的统一对象。`raw_message` 永远保留；`ai_enrichment` 与用户原文分开。
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

Workflow 的发送与最终 D1 状态是两个 durable step。发送 step 成功后其 receipt 会被缓存；即使后续状态写入重试，也不会再次发送。创建 Workflow 的瞬时错误会把 reminder 标记 failed，下一次相同幂等请求可安全 reclaim。

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
- URL 只接受公开 HTTP(S) 字面地址，手动验证每次 redirect，限制 timeout/content-type/bytes。DNS rebinding 仍属于平台网络层边界，不把网页内容当可信输入。
- 外部请求只对网络错误、429、5xx 做有限重试；永久 4xx 不重试。
- 日志按 JSON 输出，并递归遮盖 key 名中含 token、secret、authorization、api key 的字段。
- Worker 模块顶层没有可变请求状态；异步工作全部 `await` 或交给 `waitUntil()`。
