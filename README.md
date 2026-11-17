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

Studio Agent 和部署目标均由本地服务执行。云端构建、扩缩容、托管 Agent、工作流调度、在线评估、自动洞察、权限和计费尚未实现。

Agent 的环境可选 `local`、`development`、`staging`、`production`。Agent 页面会生成带 identifier 的上报示例，Dashboards 和 Traces 支持按环境筛选。

## Cloudflare 部署

Worker 在 `agentops.cloudmoro.com` 提供页面和 API。数据保存在 Cloudflare 的 SQLite Durable Object，初次部署从空工作区开始。

```sh
npx wrangler deploy
npx wrangler secret put AGENTOPS_INGEST_TOKEN
```

生产工作区须先登录。首次登录会接管该浏览器的访客工作区，此后可在其他设备用同一个邮箱继续使用。外部 Agent 从 **API Keys** 创建具有 **Send traces** 权限的密钥，调用 `POST /api/traces` 时使用 Bearer 请求头。部署后可用 `GET /healthz` 检查服务状态。

如需调用真实模型，在 Worker 中设置 `TRACE_STUDIO_MODEL` 和 `TRACE_STUDIO_MODEL_URL`，并通过 `wrangler secret put TRACE_STUDIO_MODEL_KEY` 配置模型密钥。

## 在平台接入 LLM 并创建 Agent

1. 打开 **Models**，填写连接名称、完整 Chat Completions URL、模型 ID 和 API Key（如供应商要求），保存后用 **Test connection** 试发一条消息。
2. 打开 **All agents → Build in Studio**，选择已保存的模型并填写 Agent 名称和系统指令。
3. 创建后在 **Studio** 输入消息，执行记录可在 **Traces** 查看。

支持 OpenAI 兼容的 Chat Completions 接口。Cloudflare 部署要求 HTTPS。本机 Python 版本也支持回环地址上的 HTTP 模型服务。模型密钥由服务端保存，列表和测试接口不会返回密钥。既有 Agent 仍可使用部署环境中配置的默认模型。

Cloudflare Workers AI 测试连接使用独立的私有 Worker。新账号部署时，先用 `npx wrangler deploy --config cloudflare/workers-ai/wrangler.jsonc` 部署模型适配器，再为适配器设置 `ADAPTER_KEY`。Agent Deck 通过服务绑定调用它，其他模型继续通过各自的 HTTPS 端点调用。

## 开放平台

**Models** 支持 DeepSeek、阿里云百炼（北京预设）和自定义 OpenAI 兼容接口。百炼的区域地址要与供应商 API Key 一致，可以填业务空间专属域名。保存后可发消息测试、更新连接或轮换密钥。Agent 可以更换绑定的模型。模型供应商的密钥在后端加密保存，不能从列表读出。保留部署用的 `AGENTOPS_INGEST_TOKEN`，更换它会使已加密的模型密钥和已签发的 Agent Deck API Key 失效。

**API Keys** 签发的是 Agent Deck 密钥。密钥创建时显示一次，服务端仅保留摘要，支持查看最近使用时间和即时撤销。权限按接口划分：

| 权限 | 接口 |
| --- | --- |
| Read traces | `GET /api/traces` |
| Send traces | `POST /api/traces` |
| List and run agents | `GET /api/agents`、`POST /api/platform/runs` |

```sh
curl -H "Authorization: Bearer $AGENTOPS_API_KEY" https://agentops.cloudmoro.com/api/agents
curl -H "Authorization: Bearer $AGENTOPS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"target_kind":"agent","target":"<GET /api/agents 返回的 id>","input":"你好"}' \
  https://agentops.cloudmoro.com/api/platform/runs
```

## 手机号、短信和账号

生产账号由 Cloudflare Durable Object 管理。阿里云号码认证服务负责向中国大陆手机号发送并核验短信验证码。首次验证创建账号并接管当前浏览器的访客工作区，后续可以换设备登录。账号可设置密码，设置后登录要同时验证密码与短信验证码。忘记密码时可通过短信验证码重置；退出登录会吊销当前会话。

1. 在[阿里云号码认证控制台](https://dypns.console.aliyun.com/)开通短信认证，选用支持 `code` 与 `min` 参数的登录／注册签名和模板。准备仅可调用 `dypns:SendSmsVerifyCode` 和 `dypns:CheckSmsVerifyCode` 的 RAM 凭据，具体权限名称见对应 OpenAPI 说明。
2. 用 `npx wrangler secret put <名称>` 设置 `PNVS_ACCESS_KEY_ID`、`PNVS_ACCESS_KEY_SECRET`、`PNVS_SIGN_NAME`、`PNVS_TEMPLATE_CODE`。
3. 用本人手机号实测短信收发与登录；准备正式启用时将 `REQUIRE_LOGIN` 设为字符串 `true` 并重新部署。如果尚未接好任何验证码通道，请先配置并测试再启用强制登录。

### 邮箱验证码

Cloudflare Email Sending 给用户邮箱发 6 位验证码。当前发信地址为 `login@mail.agentops.cloudmoro.com`。将发信子域加入 Email Sending，部署同名 `AUTH_EMAIL` 发信绑定并设置 `LOGIN_FROM`。请关闭发信子域的邮件正文预览。邮件验证码有效期 5 分钟，最多尝试 5 次，用过即失效。邮箱和手机号是两个登录标识，分别注册会建立独立账号。
