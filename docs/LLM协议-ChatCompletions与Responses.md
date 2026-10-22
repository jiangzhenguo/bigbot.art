# LLM 协议:Chat Completions 与 Responses

> 2026-10-20 接入 `/v1/responses`。设计目标:**同一个对话内核同时支持两套协议,并在端点报错时自动协商**,不让用户去猜「这个模型该选哪个协议」。

## 1. 两套协议的区别(为什么必须显式支持)

| | `/v1/chat/completions` | `/v1/responses` |
|---|---|---|
| 定位 | 2022 经典接口,事实上的行业标准 | OpenAI 新接口,部分模型/供应商只开这一个口子 |
| 生态 | DeepSeek / MiniMax / Kimi / GLM / OpenRouter / LM Studio / Ollama / vLLM… | 目前较少;OpenCode Go 的 grok / gpt-luna / muse 只提供它 |
| 请求形状 | `messages[]`、`max_tokens`、`tools[].function`、`response_format` | `input`(字符串或 item 列表)、`instructions`、`max_output_tokens`、`tools[].{type,name}`、`text.format` |
| 响应形状 | `choices[0].message.content` + `message.tool_calls[]` | 类型化 `output: Item[]`(`message` / `reasoning` / `function_call` …) |
| 多轮 | 无状态,客户端重发全部历史 | 可 `store:true` + `previous_response_id`(本项目仍按无状态用) |
| 工具往返 | `role:'tool'` 消息 | `function_call_output` item + 匹配的 `call_id` |
| 流式 | `choices[].delta` | 类型化事件(`response.output_text.delta` …) |

本项目的对话内核(`packages/agent/src/pi-chat.ts`)只和 pi-ai 的抽象(`Context` / `AssistantMessage` / toolCall)打交道,**两套报文的差异由 pi-ai 的 api 实现吃掉**:

- `openAICompletionsApi()` ← `@earendil-works/pi-ai/api/openai-completions.lazy`
- `openAIResponsesApi()` ← `@earendil-works/pi-ai/api/openai-responses.lazy`

所以接入新协议**不需要**重写消息构造、工具桥或历史管理,只需:选对 api 实现 + 给 model 打上正确的 `api` 字段。

## 2. 协议是怎么定的(优先级)

`apps/desktop/src/main/llm.ts` 的 `resolveModelProtocol`:

1. `LlmSource.protocol`(显式选择,项目级覆盖也走这里)
2. `CloudProviderEntry.modelProtocols[model]`(单模型覆盖 —— 因为同一供应商会混协议)
3. `CloudProviderEntry.protocol`(供应商默认)
4. 内置知识表 `OPENCODE_GO_RESPONSES_MODELS`(grok / gpt-luna / muse → `responses`)
5. 默认 `chat`

结果经 `ResolvedLlm.protocol` → `toChatLlm()` → worker 的 `LlmSource` → `PiPlanner.resolveEndpoint`,再由两个消费者各自按协议选实现:

- `pi-chat`(画布对话 + 工具循环)
- `pi-planner`(一句话起活 / 分镜表规划,`apiImplFor` / `modelApiFor` 两个工厂)

> ⚠️ `ResolvedLlm → LlmSource` 只有 `toChatLlm()` 一个出口。此前 5 处调用点各手写一份对象,新增字段漏一处的表现就是「某个入口悄悄退回 chat」。

## 3. 自动协商(兜底)

端点回「不支持这套协议」时(`PROTOCOL_UNSUPPORTED_RE`:`ModelProtocolUnsupported` / `does not support this protocol` / `unsupported api|protocol` / `unknown endpoint|url`),`pi-chat` 会**换另一套协议重试本轮**,并记一条 `[pi-chat] 端点不支持当前协议,已切换 X 协议重试`:

- 两个方向都试(chat ⇄ responses),每套协议只试一次(`triedProtocols`),两边都不认就如实抛原文,不会无限翻。
- 抛异常形态(`complete` throws)与 `stopReason:'error'` 形态都覆盖。
- 与既有的「工具名点号 → 短横线别名」「temperature 被拒 → 不下发」同一手法。

## 4. 不可用的协议:/v1/messages

`/v1/messages`(Anthropic 形状)尚未实现。OpenCode Go 的 minimax / qwen / claude-haiku 属于这一类:

- `OPENCODE_GO_NON_CHAT_MODELS` 收集它们,`filterOpenCodeGoModels` 在拉模型清单时滤掉;
- `resolveLlmEndpoint` 在**取钥匙串之前**明确拒绝,并列出该供应商可用模型;
- 存量 `settings.json` 自愈(`sanitizeOpenCodeGoSettings`)只清这一类,不再误删已支持的 responses 模型。

## 5. 单测

- `apps/desktop/src/main/__tests__/opencode-go.test.ts` — 协议分类、优先级矩阵、清单过滤、存量自愈、协议闸、`toChatLlm` 透传(23 例)
- `packages/agent/src/__tests__/protocol-switch.test.ts` — 默认 chat / 显式 responses / 双向自动切换 / 只翻一次 / 其他错误不误触发(7 例)
- `packages/agent/src/__tests__/tool-name-sanitize.test.ts` — 工具名降级(与协议无关,但同一条请求路径)

## 6. 真机验证(2026-10-20,OpenCode Go)

- `POST /v1/responses`(grok-4.6,带 function 工具)→ 200,返回 `reasoning` + `function_call` item;
- `pi-chat` 显式 `protocol='responses'` → 工具调用与收尾正常;
- `pi-chat` 不传协议(默认 chat)→ 撞 `ModelProtocolUnsupported` → 自动切 responses → 正常收尾;
- 直接用编译后的 worker 子进程走 JSON-RPC(`chat` / `plan`)各跑一轮,均正常出结果(3.6s / 34.3s)。
