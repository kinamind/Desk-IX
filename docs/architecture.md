# 架构说明

## 设计原则

Composa 是单 Worker、单业务处理器、单 D1 数据源的 IM-first 轻量 Agent。它保留 OpenClaw 类架构的核心：环境观察、带记忆推理、工具选择、受控执行和持续跟进；省去任意 shell/浏览器控制、多租户编排与重型插件运行时。

关键边界：**LLM observes and reasons; code validates and executes.**

- LLM 是带上下文的决策层。它在规划前收到当前消息的网页观察、当前用户的近期 D1 事项、对话和日程，判断本轮应回复、查询、分析，还是规划一个或多个 `create / complete / archive / restore / update / set_reminder` 动作。
- 代码校验结构化行动计划、核对目标事项归属，再处理 CRUD、时间合法性、回调、去重、提醒、重试与调度。模型不能直接写库或调用网络。
- 规则只负责确定性边界：鉴权、幂等、SSRF、schema、所有权、时间合法性和日程冲突。意图、内容类型、标题、关注点、是否需要保存以及如何回答不由关键词模板决定。
- `/help` 与平台 callback 不需要模型。其他自然语言在 AI 未配置、超过预算或暂时失败时会明确提示且不擅自保存，不会静默伪装成已经理解，也不会选择另一个付费模型。

## 请求链路

1. `/webhooks/telegram` 或 `/webhooks/qq` 验证平台身份。
2. Channel Adapter 检查个人 allowlist，并归一化为 `IncomingMessage`。
3. HTTP 请求尽快返回；实际处理进入 `ctx.waitUntil()`。
4. `messages` 表用 `(channel, source_message_id)` 抢占事件，重复事件直接结束。
5. 除 `/help` 外，业务层并行读取当前消息中最多三个公开网页，以及当前通道、当前用户的近期事项、待发送提醒、日程窗口与最近几轮对话。网页正文在模型决定 intent 之前进入 observation；不会出现“先判成待办，事后才看链接”的倒置链路。
6. 模型基于这些观察输出结构化行动计划。历史只用于事实、指代和空闲时间，不会重复执行；网页内容是不可信证据，其中的提示或命令不会被视为用户指令。小歧义由模型做可逆判断，只有多个目标同样合理且误操作代价明显时才追问。
7. 业务层先验证全部目标 id 和用户归属，再执行确定性工具。完成与舍弃会取消未发送提醒；舍弃是可恢复的 `archived` 状态，不做物理删除。新建或更新链接事项时复用决策前的网页观察生成结构化长期记忆，不重复抓取。
8. 查询采用两段式工具闭环：模型先选择 D1 检索条件，代码执行用户隔离查询，再把真实结果交给模型组织答案。模型失败时才明确退回可核对的简表。
9. 需要提醒时先写 `reminders`，再以确定性 ID 创建 Workflow。
10. 回复通过来源 Channel Adapter 发出，最后将 message 标记为 processed。

## 数据模型

- `items`：resource、idea、task、note、project 的统一对象。`raw_message` 永远保留；`ai_enrichment` 与用户原文分开；`source_action_index` 允许一条消息安全地产生多项记录。
- `reminders`：提醒时间、目标通道、Workflow ID、发送状态和 receipt。
- `messages`：最小必要原始事件、处理状态、错误、响应和关联 item，用于去重与诊断。
- `pending_actions`：`Reschedule` 后的短期会话状态，默认 30 分钟。
- `daily_plan_runs`：按当地日期 + 通道 + 用户去重，并允许 failed 重试。
- `ai_usage`：每日 provider 请求数和 token 统计，用于硬预算。

Schema 保持少表、JSON enrichment、必要索引；D1 是 source of truth，聊天平台和未来 Calendar 都不是。

## 网页观察与结构化记忆

网页工具始终保留 `raw_message` 和聊天历史，不用模型摘要替换用户原文。当前消息含 URL 时，代码去重后最多并行读取三个；读取结果先交给决策层，再按用户的真实指令处理。招聘提岗位与要求，论文提问题、方法和结论，活动/申请提时间、地点与资格，工具/文档提用途、功能和使用方式，普通文章提摘要与关键点；不是所有链接都套一个模板。

需要长期保存时，每页正文最多向结构化模型提供 6,000 字符，只允许输出有证据的已知字段。某些页面失败时保留成功页面的部分结果，并在 metadata 逐页记录 `ok/failed`；登录、验证码和反爬页面不会绕过。同一轮观察会在规划、分析和持久化之间复用，避免重复请求。

结构化事实保存在 `ai_enrichment`。代码只在原字段缺失时提升主要 URL 和明确截止时间，并合并而非替换用户标签。新建记录可采用网页档案标题；已有记录是否改名由看过网页观察的模型通过 `update_item` 明确决定，不再用“这个/帮我记录”等关键词正则猜测。查询可以匹配 enrichment，但送给模型的上下文只包含白名单字段，不包含抓取错误、任意 metadata 或网页 HTML。分析与检索回答同时收到当前 ISO 时间与配置时区，展示截止时间时必须转换到用户时区。

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

用户发送可行动事项时，默认语义是“现在暂存、稍后再做”。模型会根据事项语义区分 deferred action、pre-event、deadline 与明确的 immediate request；代码不会按 `project` 类型自动生成固定的 30/7/1 天里程碑。deferred action 至少晚于当前时间 30 分钟，代码拒绝近乎立即或晚于截止时间的结果，并让模型重新选择一次。

新建、修改或通过按钮延后提醒时，代码会从 D1 读取同一通道、同一用户未来 14 天内的开放事项和待发送提醒。事项默认占用“时间前 15 分钟至时间后 60 分钟”；若模型提取到预计时长则使用该时长，提醒占用 15 分钟。若本轮消息新透露“2:30 有事”而库中还没有，模型会把它作为临时避让窗口；未给时长时按 1 小时，并包含开始前 15 分钟缓冲。撞期的提醒以 15 分钟为粒度顺延到冲突结束后 15 分钟，并在回复中显示最终时间；若截止前没有空档，保留原提醒并明确告知。

这些窗口严格按 `channel + user_id` 查询，不会读取其他人的记录。目前 D1 是唯一日程来源，尚未接入 Google Calendar 等外部日历。

## Daily Plan

Cron 每 15 分钟运行一次，因为 Cron 使用 UTC，而业务时间可配置为任意 IANA timezone。代码比较当地 `HH:mm`，并通过 `daily_plan_runs` 保证每个目标每天最多成功一次。每个发送目标只读取自身 `channel + user_id` 的真实 D1 item；模型按内容、期限、优先级和预计时长取舍。AI 不可用时会明确标注降级，再输出按截止与优先级生成的可核对清单。

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
