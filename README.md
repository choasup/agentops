# Agent Deck

本地 Agent 观测控制台，参考 LangSmith Observability 的追踪和监控流程。

## 启动

在项目目录运行 `python3 server.py`，打开 [本地控制台](http://127.0.0.1:8765)。使用 Python 标准库，无需安装依赖。可用 `--port` 指定端口。

首次打开时显示示例数据。收到真实 Trace 后，控制台自动切换到 SQLite 中的真实数据。

## 上报 Trace

```sh
curl -X POST http://127.0.0.1:8765/api/traces \
  -H 'Content-Type: application/json' \
  -d '{"name":"support_agent","project":"my-agent","status":"success","duration":840,"tokens":256,"cost":0.001,"input":{"query":"Hello"},"output":{"answer":"Hi"},"steps":[{"name":"generate","type":"llm","duration":840}]}'
```

`name` 必填。默认项目为 `default`，状态支持 `success` 和 `error`。耗时单位为毫秒，成本单位为美元。步骤可包含输入、输出、错误或子步骤。服务接收时生成 Trace ID 和时间戳，数据保存到项目目录下的 `traces.sqlite3`。

通过项目下拉框选择统计范围，或在 Traces 中按状态和关键字筛选。点击 Trace 名称可展开执行步骤及其载荷。服务仅监听本机。

## 开发与评估

1. 在 **Prompts** 保存模板。以同一名称继续保存可追加版本，`{{input}}` 等变量来自输入 JSON。
2. 在 **Playground** 选择版本并试跑。默认返回渲染后的模板。
3. 在 **Datasets** 添加输入和参考输出，在 **Experiments** 运行精确匹配评估并展开查看每条结果。
4. 在 **All agents** 创建 Studio Agent 并填写系统指令，或登记外部 Agent。通过 **Studio** 运行已配置模型的 Agent。外部 Agent 使用稳定的 identifier 和 environment 上报到 `/api/traces`。Deployments 可另外保存引用固定 Prompt 版本的本地目标。
5. 在 **Review Queue** 为已上报的 Trace 记录通过或失败及评论。

可以设置 `TRACE_STUDIO_MODEL` 和 `TRACE_STUDIO_MODEL_URL`，让 Playground、Experiments 和 Studio 使用 OpenAI 兼容的 Chat Completions 服务。URL 须包含完整端点路径，若服务需要认证则同时设置 `TRACE_STUDIO_MODEL_KEY`。实验会逐条调用模型，Studio 会记录服务返回的 token 用量。

本节描述 Python 本地版本。Cloudflare 部署另提供邮箱登录、API Key 和托管模型计费。

Agent 的环境可选 `local`、`development`、`staging`、`production`。Agent 页面会生成带 identifier 的上报示例，Dashboards 和 Traces 支持按环境筛选。

## Cloudflare 部署

主站为 [agentdeck.cloudmoro.com](https://agentdeck.cloudmoro.com/)。旧站 agentops.cloudmoro.com 返回 308 并保留路径和查询参数。API 客户端请直接使用新域名。

Worker 在主站提供页面和 API。数据保存在 Cloudflare 的 SQLite Durable Object，初次部署从空工作区开始。

```sh
npx wrangler deploy
npx wrangler secret put AGENTOPS_INGEST_TOKEN
```

生产工作区须先登录。首次登录会接管该浏览器的访客工作区，此后可在其他设备用同一个邮箱继续使用。外部 Agent 注册后会显示接入步骤。到 **Billing → API Keys** 创建具有 **Send traces** 权限的密钥，从你的应用携带 Bearer Key 和 Agent ID 调用 `POST /api/traces`。回到 Agent 列表的 **Set up** 或 **Integration**，检查首条 Trace 是否收到。部署后可用 `GET /healthz` 检查服务状态。

如需调用真实模型，在 Worker 中设置 `TRACE_STUDIO_MODEL` 和 `TRACE_STUDIO_MODEL_URL`，并通过 `wrangler secret put TRACE_STUDIO_MODEL_KEY` 配置模型密钥。

## 在平台接入 LLM 并创建 Agent

1. 打开 **Models**，填写连接名称、完整 Chat Completions URL、模型 ID 和 API Key（如供应商要求），保存后用 **Test connection** 试发一条消息。
2. 打开 **All agents → New agent**，选择已保存的模型并填写 Agent 名称和系统指令。
3. 创建后在 **Studio** 输入消息，执行记录可在 **Traces** 查看。

支持 OpenAI 兼容的 Chat Completions 接口。Cloudflare 部署要求 HTTPS。本机 Python 版本也支持回环地址上的 HTTP 模型服务。模型密钥由服务端保存，列表和测试接口不会返回密钥。既有 Agent 仍可使用部署环境中配置的默认模型。

Cloudflare Workers AI 测试连接使用独立的私有 Worker。新账号部署时，先用 `npx wrangler deploy --config cloudflare/workers-ai/wrangler.jsonc` 部署模型适配器，再为适配器设置 `ADAPTER_KEY`。Agent Deck 通过服务绑定调用它，其他模型继续通过各自的 HTTPS 端点调用。

## 开放平台

### 发布 Agent 版本（Cloudflare）

在 **Deployments** 保存 Studio Agent 的当前配置，给版本命名，再选择 **Staging** 或 **Production** 发布。环境独立指向已保存版本，更新 Studio 草稿不会改动已发布配置。若模型 ID 或端点发生变化，已有版本会拒绝运行，直到恢复连接配置或保存并发布新版本。可单独轮换供应商密钥。

发布到 **Production** 前，到 **Experiments → Compare Agent versions** 选择同一 Agent 的两个版本和包含 1–5 条文本示例的数据集。结果保留每条示例的实际与预期回复。系统在去掉首尾空白后做严格匹配，被发布版本须在最近一次比较中全部通过。托管模型评估使用所选 API Key 计费。

在 **Active Agent releases → Run via API** 查看请求参数。调用 `POST /api/platform/runs` 时传 `target_kind: "agent_release"`、Agent 的记录 ID、`environment` 和 `input`。Key 需要 **List and run agents** 权限，托管模型还需要 **Call hosted models**。Trace 会记录环境和版本 ID，托管模型仍使用调用 Key 结算。若需回退，在该环境选择 **Roll back to …**。

用 Node 22.15+ 运行 `node --test tests/agent-releases.test.mjs`，可在内存工作区验证版本隔离、权限、评估结果、发布门槛、回滚和账单归属。

**Models** 支持 DeepSeek、阿里云百炼（北京预设）和自定义 OpenAI 兼容接口。百炼的区域地址要与供应商 API Key 一致，可以填业务空间专属域名。保存后可发消息测试、更新连接或轮换密钥。Agent 可以更换绑定的模型。模型供应商的密钥在后端加密保存，不能从列表读出。保留部署用的 `AGENTOPS_INGEST_TOKEN`，更换它会使已加密的模型密钥和已签发的 Agent Deck API Key 失效。

**Billing → API Keys** 签发的是 Agent Deck 密钥。密钥创建时显示一次，服务端仅保留摘要，支持查看最近使用时间和即时撤销。权限按接口划分：

| 权限 | 接口 |
| --- | --- |
| Read traces | `GET /api/traces` |
| Send traces | `POST /api/traces` |
| Create agents and list models | `POST /api/agents`、`GET /api/models` |
| List and run agents | `GET /api/agents`、`POST /api/platform/runs` |
| Call hosted models | `POST /v1/chat/completions`；调用托管 Studio Agent 还需要 List and run agents |

```sh
curl -H "Authorization: Bearer $AGENTOPS_API_KEY" https://agentdeck.cloudmoro.com/api/agents
curl -H "Authorization: Bearer $AGENTOPS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"target_kind":"agent","target":"<GET /api/agents 返回的 id>","input":"你好"}' \
  https://agentdeck.cloudmoro.com/api/platform/runs
```

### Agent Deck CLI

使用 Node.js 20+。在 **Billing → API Keys** 创建带 **Create agents and list models** 权限的 Key，并在终端设置环境变量 `AGENT_DECK_API_KEY`。如需列出已创建的 Agent，再勾选 **List and run agents**。

```sh
curl --fail --silent --show-error https://agentdeck.cloudmoro.com/agentdeck.mjs -o agentdeck.mjs
node agentdeck.mjs models list
node agentdeck.mjs agents create --name "Repository guide" --model hosted:deepseek \
  --prompt "Explain this repository to new contributors."
node agentdeck.mjs agents list
```

`--model` 使用模型列表中的 ID。可以用 `--prompt-file instructions.md` 读取本地文件，文件内容会作为 Agent 指令提交。用 `node agentdeck.mjs agents create --name "Existing agent" --external` 注册外部 Agent。创建结果输出为 JSON，Agent 会出现在同一工作区的 **Home → All agents**。

### DeepSeek 托管 API

通过 `npx wrangler secret put DEEPSEEK_API_KEY` 为 Worker 配置平台的 DeepSeek 密钥。用户创建带 **Call hosted models** 权限的 Agent Deck Key 后可直接调用。登录后在 Studio 试跑直接从工作区余额扣费，账单标为 **Studio test**。

```sh
curl https://agentdeck.cloudmoro.com/v1/chat/completions \
  -H "Authorization: Bearer $AGENTOPS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"Say hello"}],"max_tokens":32}'
```

首版支持非流式文本调用。账号余额以美元计，按实际缓存输入、普通输入和输出 Token 分别计价，固定为每百万 Token USD 0.006、0.30 和 1.20。余额、账单及各 Key 的调用汇总在 **Billing** 查看。响应中的 `agent_deck.trace_id` 对应同一笔扣费和 Trace，`cost_nanos` 的单位是十亿分之一美元。

充值使用 Stripe Checkout。为 Worker 配置 `STRIPE_SECRET_KEY` 和 `STRIPE_WEBHOOK_SECRET`，将 Stripe 的 `checkout.session.completed` 发往 `https://agentdeck.cloudmoro.com/api/billing/stripe`。到账以通过签名验证的已支付事件为准。只在独立测试工作区和独立存储环境使用 `BILLING_TEST_MODE=true` 与 Stripe 测试密钥。当前余额账本记录充值和模型消费，退款与拒付需人工对账。

## 手机号、短信和账号

生产账号由 Cloudflare Durable Object 管理。阿里云号码认证服务负责向中国大陆手机号发送并核验短信验证码。用户通过「创建账号」验证联系方式并接管当前浏览器的访客工作区，注册时设置密码，日常使用账号和密码登录。验证码用于注册和找回密码，不能混用。还未设置密码的旧账号可通过找回密码设置。退出登录会吊销当前会话。

1. 在[阿里云号码认证控制台](https://dypns.console.aliyun.com/)开通短信认证，选用支持 `code` 与 `min` 参数的登录／注册签名和模板。准备仅可调用 `dypns:SendSmsVerifyCode` 和 `dypns:CheckSmsVerifyCode` 的 RAM 凭据，具体权限名称见对应 OpenAPI 说明。
2. 用 `npx wrangler secret put <名称>` 设置 `PNVS_ACCESS_KEY_ID`、`PNVS_ACCESS_KEY_SECRET`、`PNVS_SIGN_NAME`、`PNVS_TEMPLATE_CODE`。
3. 用本人手机号实测短信收发与登录；准备正式启用时将 `REQUIRE_LOGIN` 设为字符串 `true` 并重新部署。如果尚未接好任何验证码通道，请先配置并测试再启用强制登录。

### 邮箱验证码

Cloudflare Email Sending 给用户邮箱发 6 位验证码。当前发信地址为 `login@mail.agentops.cloudmoro.com`。将发信子域加入 Email Sending，部署同名 `AUTH_EMAIL` 发信绑定并设置 `LOGIN_FROM`。请关闭发信子域的邮件正文预览。邮件验证码有效期 5 分钟，最多尝试 5 次，用过即失效。邮箱和手机号是两个登录标识，分别注册会建立独立账号。
