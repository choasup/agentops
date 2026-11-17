# AgentOps

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
npx wrangler secret put AGENTOPS_PASSWORD
npx wrangler secret put AGENTOPS_INGEST_TOKEN
```

网页登录用户名为 `agentops`。外部 Agent 向 `POST /api/traces` 发送 JSON 时使用 `Authorization: Bearer <AGENTOPS_INGEST_TOKEN>`。该令牌仅允许写入 Trace。部署后可用 `GET /healthz` 检查服务状态。

如需调用真实模型，在 Worker 中设置 `TRACE_STUDIO_MODEL` 和 `TRACE_STUDIO_MODEL_URL`，并通过 `wrangler secret put TRACE_STUDIO_MODEL_KEY` 配置模型密钥。

## 在平台接入 LLM 并创建 Agent

1. 打开 **Models**，填写连接名称、完整 Chat Completions URL、模型 ID 和 API Key（如供应商要求），保存后用 **Test connection** 试发一条消息。
2. 打开 **All agents → Build in Studio**，选择已保存的模型并填写 Agent 名称和系统指令。
3. 创建后在 **Studio** 输入消息，执行记录可在 **Traces** 查看。

支持 OpenAI 兼容的 Chat Completions 接口。Cloudflare 部署要求 HTTPS。本机 Python 版本也支持回环地址上的 HTTP 模型服务。模型密钥由服务端保存，列表和测试接口不会返回密钥。既有 Agent 仍可使用部署环境中配置的默认模型。
