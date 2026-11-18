# Agent Deck 微信渠道网关

在 **Console → Agents → Releases** 发布到 Staging 或 Production，再进入 **WeChat channels** 选渠道和环境。网关部署在自己的 Node.js 22.15+ 服务上，转发文本消息到已发布的 Agent。每轮调用生成 Trace。两个渠道目前按单条文本处理。

进入仓库的 `channels` 目录，执行 `npm install`。在服务的环境变量里配置：

| 环境变量 | 值 |
| --- | --- |
| `AGENT_DECK_AGENT_ID` | 渠道设置弹窗里的 Agent ID |
| `AGENT_DECK_ENVIRONMENT` | `staging` 或 `production` |
| `AGENT_DECK_API_KEY` | Billing 里创建的 Key，需 **List and run agents**，托管模型还需 **Call hosted models** |

## 企业微信智能机器人

在企业微信创建智能机器人，选择 API 模式中的长连接。把 Bot ID 和 Secret 配置为 `WECOM_BOT_ID`、`WECOM_BOT_SECRET`，启动 `node gateway.mjs wecom`。看到认证成功后，给机器人发一条测试消息。该进程需要常驻运行，主动连企业微信，无需回调域名。 [腾讯官方接入说明](https://intl.cloud.tencent.com/zh/document/product/1316/84454)

## 微信客服

准备已开通微信客服 API 的企业和客服帐号。设置：

- `WECHAT_KF_CORP_ID` 和 `WECHAT_KF_SECRET`：企业 ID 和用于获取微信客服 API access token 的 Secret。
- `WECHAT_KF_OPEN_KFID`：需要接管的客服帐号 ID。
- `WECHAT_KF_CALLBACK_TOKEN`、`WECHAT_KF_ENCODING_AES_KEY`：企业微信后台配置的回调 Token 和 EncodingAESKey。
- `PORT`：本机回调端口，默认 8788。`WECHAT_KF_DB`：持久化 SQLite 路径，默认 `wechat-kf.sqlite3`。每个客服帐号使用单独数据库和网关进程。

启动 `node gateway.mjs wechat-kf`。用自己的 HTTPS 反向代理把 `/wechat-kf/callback` 转发到网关监听的回环端口，再到企业微信后台填写完整 HTTPS 回调地址和密钥。如果后台要求可信 IP，添加网关的出口 IP。用该客服帐号的微信客服入口发测试消息，并检查 Console Trace。网关只回复新接入或由智能助手接待的文本消息。 [微信客服接收消息](https://developer.work.weixin.qq.com/document/path/94670) · [微信客服发送消息](https://developer.work.weixin.qq.com/document/path/94677)
