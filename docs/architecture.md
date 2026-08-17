# Desk-IX v2 架构说明

## 设计取舍

Desk-IX v2 从 OpenClaw 的实现出发做减法，而不是继续扩充意图分类器。保留的是让 Agent 真正具备组合能力的内核：每个会话串行处理、模型原生选择工具、工具结果回到同一轮上下文、持久状态、幂等写入、生命周期观测和可靠投递。

省去的是个人助理当前不需要或 Cloudflare Workers 不适合承载的重量：任意 shell 与浏览器控制、MCP、插件市场、多 Agent 编排、本机工作区、复杂模型路由和通用 Gateway。

关键边界仍然是：**模型负责理解与组合，代码负责权限与事实。**

- 模型可以根据每次工具结果决定下一步，不需要先选一个 `intent`。
- 代码硬性限制可用工具、当前用户所有权、参数 schema、幂等、SSRF、提醒合法性、冲突、预算与最长步数。
- D1 是事项、提醒和审计的业务事实源；Durable Object 保存会话运行状态和回复 outbox。
- 固定 callback、Webhook 验签、Workflow 与 Daily Plan 继续走确定性链路。
- AI 未配置、超预算或失败时明确说明，不擅自把消息保存成记录，也不切换未经配置的付费模型。

## 一轮消息如何运行

```mermaid
sequenceDiagram
  participant U as 用户
  participant C as Telegram / QQ
  participant W as Worker Ingress
  participant S as Per-user Agent Session
  participant M as Model
  participant T as Scoped Tools
  participant D as D1 / Web / Workflow

  U->>C: 自然语言
  C->>W: 已验证 webhook
  W->>W: allowlist + 事件去重
  W->>S: 以 eventId 幂等提交
  S->>M: 会话历史 + 个人档案 + 当前时间 + 待处理交互
  loop 最多 6 个模型步骤
    M->>T: 原生 tool call
    T->>D: 校验后读取或写入
    D-->>T: 可核对结果
    T-->>M: tool result
  end
  M-->>S: 最终回复
  S->>S: 写入回复 outbox
  S->>C: 发送并结算投递状态
  C-->>U: 回复
```

会话 ID 是 `channel + userId` 的哈希，因此同一用户的消息排队处理，不会出现两个并发回合同时修改“刚才那个”。平台重复投递同一事件时，D1 inbox、Think submission 和写工具分别使用稳定幂等键。

## Agent 能看到的工具

运行时只开放十一个应用工具：

| 工具 | 用途 |
|---|---|
| `memory_search` | 搜索当前用户的事项，解析“刚才那个”等指代 |
| `item_get` | 读取一个确定事项及其提醒 |
| `web_read` | 读取最多三个普通公开网页，或读取事项中保存的链接 |
| `schedule_list` | 查看当前用户未来日程与提醒窗口 |
| `profile_get` | 读取当前用户的称呼、时区、作息与沟通偏好 |
| `item_create` | 新建真正的新事项 |
| `item_update` | 更新原事项及结构化事实、来源 |
| `item_transition` | 完成、舍弃/归档、恢复 |
| `reminder_manage` | 设置、改期或取消提醒 |
| `lifecycle_followup_manage` | 由 Agent 为具体事项安排或取消事后复盘 |
| `profile_update` | 更新当前用户明确表达或授权自主选择的个人偏好 |

模型没有 bash、文件系统、MCP 或任意网络请求能力。读取工具先从当前会话身份取得 `channel + userId`；写工具还要求运行时权限，并为每个动作生成稳定幂等键。

例如“根据刚才的链接内容更新一下深圳理工大学的招聘信息”不对应某个复合意图。典型执行链是：

```text
memory_search → item_get → web_read → item_update → 自然语言说明改了什么
```

模型可以根据搜索和网页结果改变下一步；代码只校验目标确实属于当前用户、网页公开可读、更新字段合规。

## 数据与运行状态

- `items`：resource、idea、task、note、project 的统一对象。`raw_message` 保留用户原文，`ai_enrichment` 保存网页事实。
- `reminders`：提醒时间、通道目标、Workflow 与投递状态。
- `messages`：Webhook 事件去重、处理状态、错误和回复审计。
- `pending_actions`：按钮“改期”后的短期上下文，由下一轮 Agent 直接取得精确 item ID。
- `user_profiles`：相互称呼、每用户时区、每日安排订阅与时间、作息目标和沟通偏好。
- `daily_plan_runs`、`ai_usage`：每日计划幂等与 AI 预算。
- Durable Object SQLite：Think 会话状态、submission 状态，以及 Desk-IX 自己的 turn-origin / reply-outbox 表。

Think 是实验性依赖，限定在 `src/agent/` 内。即使未来替换运行时，D1 里的事项与提醒无需迁移；HTTP ingress 只依赖 `receive()` 这一层应用接口。

## 网页、提醒与生命周期

`web_read` 只接受普通公开 HTTP(S) 地址，手动验证每次跳转，限制超时、正文类型、体积和每轮数量，不绕过登录、验证码或反爬。网页正文被视为不可信证据，不能授予权限，也不能覆盖用户指令。

提醒由模型理解自然语言并选择绝对时间；代码拒绝过去时间和非明确要求的近乎即时提醒。“下午、晚上、晚点”等被当作一个范围而不是固定钟点。模型自主选时间时必须先调用 `schedule_list`，结合本地时间、截止时间、紧迫度、预计耗时、用户作息与提醒密度作出选择。若这个 Agent 自选时刻与已有窗口冲突，即使模型请求强行接受，工具仍会把冲突返回到同一轮要求重选；只有用户亲自说出的具体钟点才允许明确覆盖冲突。提醒写入 D1 后由 Cloudflare Workflow 持久等待；完成或舍弃事项会取消未发送提醒。

生命周期不是创建新待办：对已有事项的完成、舍弃、恢复和修改都必须先解析到原 item ID，再调用对应工具。小歧义由模型做可逆判断，只有多个目标同样合理且误操作代价明显时才追问。

时间明确的事项还可以有一次 Agent 自己安排的事后复盘。模型在当前回合判断“是否值得复盘”和“何时复盘”，Agents SDK 只负责为该用户会话持久保存唤醒时间。到点后会产生一个可审计的内部 Agent 回合，重新读取原事项、记忆与日程，分别判断事件是否发生/结束以及目标或结果是否确定：证据充分时可完成并告知、允许用户纠正；不确定时保持原状态并询问或稍后再看；若事件结束但留下行动，则完成原事件并拆出后续。代码没有“会议自动完成”或按事项类型分类的状态规则。完成、舍弃或归档事项时，其尚未触发的复盘也会取消。

这里的职责边界是：**模型负责具体时间与生命周期判断；代码负责所有权、冲突保护、持久唤醒、幂等和可靠投递。**

## Daily Plan 与固定回调

Daily Plan 仍由 Cron 每 15 分钟唤醒，但发送对象、IANA 时区和偏好时间来自 `user_profiles`，不再依赖隐藏的部署目标列表。每个档案独立计算本地日期，并通过 `daily_plan_runs` 保证每天最多成功一次。它从 D1 读取当前用户真实事项、提醒与忙碌窗口；AI 只负责取舍、安排和符合个人风格的表达。

按钮 callback 已携带明确动作和 item ID，不需要浪费一次 Agent 回合。`完成`、`舍弃`、`稍后`、`改期`、`详情` 继续由确定性处理器执行；其中“改期”写入 `pending_actions`，下一句自然语言进入 Agent 会话。

## 安全、成本与已知边界

- 所有 SQL 参数化；所有业务读写按 `channel + userId` 隔离。
- Telegram secret、Admin token 与 QQ Ed25519 验签保持在 Agent 入口之外。
- 单回合最多 6 个模型步骤，每步和工具都有超时，每日请求计入同一预算。
- 回复先记入 DO outbox 再调用平台；失败可在重复 webhook 时恢复。
- 外部聊天平台不存在跨系统原子事务：若平台已接受消息而 Worker 在落账前崩溃，仍可能出现极低概率重复投递，这是当前的分布式系统边界。
- 受管理员令牌保护的单事项提醒接口使用同一套 D1 + Workflow 调度链路，可用于安全维护改期；它不接受通道或用户 ID，投递目标始终来自事项本身。
- 当前日程只包含 Desk-IX 自己的事项与提醒，尚未接入外部 Calendar；作息建议不是医疗建议，也不会在没有用户目标时编造具体睡眠时间。

完整 OpenClaw 对照研究见 [研究报告](research/openclaw-composa-v2-2026-08-16/report.md)，迁移步骤见 [实施计划](superpowers/plans/2026-08-16-composa-v2-openclaw-runtime.md)。
