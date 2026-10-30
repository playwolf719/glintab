# 审核员测试说明

发布者：playwolf719；支持邮箱：playwolf719@gmail.com。适用版本：0.1.0，Chrome 116+。

## 可提交到 Test instructions 的英文说明

Glintab helps users summarize and ask questions about a selected web page or accessible video transcript. The interface is in Simplified Chinese. There is no Glintab account or subscription. AI generation requires a user-configured model endpoint and valid credentials; external providers may charge for usage. The extension does not include free AI credits.

1. Install the extension and open its options page (扩展程序选项). Under AI 供应商, choose 添加供应商. Enter the provider name, protocol, Base URL, API Key and a model supported by that service. Choose 保存并授权 and approve access to that service domain.
2. Open a normal HTTPS article and click the Glintab toolbar icon. Click 帮我总结这篇网页 to summarize, or type a question and press Enter. If additional page access is needed, choose 仅授权当前网站 for this site; 一次授权所有网站 is an optional broader grant.
3. Wait for the answer. Ask a follow-up question, copy a response or edit the last question. 停止生成 cancels a running request and preserves partial text. Closing the panel does not stop an active generation task; reopening reconnects to it.
4. Click 查看正文 to inspect, copy or download the extracted source. 重新提取并摘要 reads the current DOM. 刷新页面并摘要 reloads the selected page before extracting and summarizing it; this replaces that page's conversation.
5. Under 摘要指令, edit and save separate web/video prompts or domain-specific prompts. Under 通用设置, 清除全部本地数据 removes local settings, credentials and conversations after running tasks have been stopped.
6. Optional video feature: open a YouTube video or a regular Bilibili upload with accessible captions, then choose 帮我总结这个视频. 查看字幕 shows available timestamps and Markdown export. Bilibili uses the current part only. Captions depend on the video, sign-in state and platform endpoints; YouTube without accessible captions is unsupported.
7. Optional Bilibili audio transcription is disabled by default. It needs a separate compatible transcription endpoint, API Key and model in 语音转写, plus explicit service/CDN permission. It is used only when Bilibili explicitly reports no subtitles, for supported uploads up to 60 minutes and a compressed audio limit of 64 MB. Audio is sent to the configured transcription service; text is then sent to the selected summary model. There is no microphone recording or YouTube audio transcription.

ChatGPT account connection is an optional Codex-compatible integration and is not required for the API Key workflow. It is not an official OpenAI extension. Actual account access, region restrictions and model availability require live verification; automated tests use simulated identities and do not establish official platform support.

All executable code is bundled. Settings, credentials and the latest 10 URL conversations are stored locally; API keys and tokens are not encrypted at rest. User-initiated generation sends necessary source content, URL, title, prompts and history directly to the selected model service. There is no publisher-operated content relay, analytics or advertising. Optional transcription sends audio directly to the configured service. Local deletion cannot recall data already sent to a service.

## 提交前补齐测试访问方式

Test instructions 本身是可选字段，但主功能依赖外部服务时，准备可复现的测试访问能帮助审核。当前没有可填写的真实测试端点或测试密钥，**不要把占位符当成可用凭证提交**。若提供临时测试服务，使用审核期有效的专用限额凭证，仅在商店私有审核字段填写，勿放进代码、截图或公开文案。

需要填入的实际信息：协议、Base URL、模型 ID、审核专用凭证及有效期。测试凭证应覆盖摘要与追问；B 站转写如需验收，另提供可用服务。不得提供个人 ChatGPT 密码或完整 `auth.json`。

## 无付费调用的本地演示（开发者复现）

仓库安装依赖后运行：

```bash
npm ci
npm run release:demo
```

然后在已安装的生产扩展中添加以下供应商，保存时手动同意访问本机服务：

| 字段       | 值                                    |
| ---------- | ------------------------------------- |
| 供应商名称 | 本地演示（固定示例）                  |
| API 协议   | OpenAI Chat Completions               |
| Base URL   | `http://127.0.0.1:4318/v1`            |
| API Key    | `demo-only`（示例字符串，无真实权限） |
| 模型       | `demo-reading`                        |
| 阅读页面   | `http://127.0.0.1:4318/article`       |

服务仅监听回环地址，不记录请求，不使用真实模型。模型响应是固定演示文本，只用于复现配置、提取、流式问答和本地保存链路；不是模型质量、真实平台或权限弹窗验收，也不作为真实外部服务凭证的替代。不会包含在商店扩展 ZIP 中。终端 Ctrl+C 关闭服务。
