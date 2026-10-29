# Glintab

中文优先、支持 API Key 和 ChatGPT 账号授权的 Chrome 网页阅读助手。基于 [REBUILD_GUIDE_ZH.md](REBUILD_GUIDE_ZH.md) 独立实现，以可安装的第一版为交付范围，保留清晰的模块边界，便于继续加入视频字幕、引用和笔记功能。

## 安装使用

环境：Node.js **22.12+**，推荐 Node.js 22 LTS；Chrome **116+**。

```bash
npm ci
npm run check
npm run zip
```

1. 打开 `chrome://extensions`，启用「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目中的 **`output/chrome-mv3`** 目录。
3. 从扩展的「详细信息 → 扩展程序选项」进入设置，添加供应商；也可以在网页打开 Glintab 后点击设置。
4. 填写服务商名称、API 协议、Base URL、API Key、模型 ID 和上下文上限，点击「保存并授权」，允许访问该模型域名。
5. 打开一篇普通网页，点击浏览器工具栏中的 Glintab 图标，选择「帮我总结这篇网页」，或直接输入问题。

如提示缺少网站读取权限，点击「一次授权所有网站」并在浏览器中允许，之后新标签页和不同网站均可使用，无需逐站授权。也可选择「仅授权当前网站」。模型域名授权与网页读取授权各自独立；点击工具栏提供的 `activeTab` 仅是对应标签页的临时权限。浏览器内置页、扩展商店等受限页面仍无法读取。

已经构建的目录可直接安装；分发 zip 位于 `output/glintab-0.1.0-chrome.zip`。更新代码后重新构建，并在扩展管理页点击「重新加载」。

### 配置模型

| 协议                      | Base URL 示例                              | 自动追加的路径                    |
| ------------------------- | ------------------------------------------ | --------------------------------- |
| OpenAI Chat Completions   | `https://api.example.com/v1`               | `/chat/completions`               |
| OpenAI Responses          | `https://api.example.com/v1`               | `/responses`                      |
| Anthropic Messages        | `https://api.anthropic.com` 或结尾带 `/v1` | `/v1/messages`，已有 `/v1` 不重复 |
| Ollama 的 OpenAI 兼容接口 | `http://localhost:11434/v1`                | `/chat/completions`               |

预设仅填写地址和协议，**不硬编码可能过期的模型名称**。模型列表可从端点获取，失败时可以手动填写。模型兼容性取决于目标服务商，测试不使用真实密钥。

导入支持 Claude Code settings JSON、Codex API Key JSON / provider TOML、OpenCode JSON 和通用 JSON。仅保存解析后的必要字段，不保存配置原文。不读取本机隐藏目录，不支持 OAuth 令牌导入。

### 使用 ChatGPT 账号

在插件的「添加供应商」中选择「ChatGPT 账号登录」，点击「使用 ChatGPT 登录」，允许访问授权和模型域名。在新标签页完成 OpenAI 授权后，扩展会自动捕获回调、交换并保存凭证。回到插件选择模型，再点击「保存连接」。**无需启动本机服务或保持终端运行。**

这是 Codex 兼容接入，使用 ChatGPT 账号授权及 Codex Responses 后端，与 API Key 模式、OpenAI 动态注册 OSS 客户端流程不同。真实账号的授权、回调地址接受情况、模型权限及地区策略仍需用户联调；自动测试使用模拟身份，不代表真实平台已验收。

令牌由后台 Repository 保存到浏览器扩展本地存储，未加密；配置和界面只持有连接 ID 与账号显示信息。使用时自动刷新，401 后最多刷新并重试一次。不读取或改写 Codex 的凭证文件，也不需要手动生成或粘贴 `auth.json` / `config.toml`。删除连接会移除此浏览器的凭证，远程授权需在 OpenAI 账号设置中管理。详见 [ChatGPT 登录说明](docs/CHATGPT_LOGIN.md)。

## 第一版能力

- 网页右侧抽屉，支持拖拽宽度、双击恢复、关闭；受限页使用原生侧栏，亦可弹出独立窗口。
- Mozilla Readability 提取正文，Markdown 转换；可查看、复制、下载提取内容，显示长度和截断情况。
- 一键摘要、首轮直接提问、多轮追问、Markdown 安全显示、停止保留部分回答。
- 消息复制和最后一个问题编辑重发；支持 Enter 发送、Shift+Enter 换行和中文输入法。
- 三种模型协议、多个供应商切换、模型列表、配置导入、自定义摘要指令和回答语言。
- 最近 10 个网址的本地历史；界面关闭后，offscreen 内的 Worker 继续执行任务。
- 任务按 `tabId + pageKey` 隔离；独立 `streamId` 去重、事件序号过滤、真实任务快照恢复。
- 模型上下文预算、正文缩减和完整历史回合裁剪；无模型压缩调用，界面明确显示缩减提示。
- 单一后台写入仓储、写入失败提示和清除全部本地数据。

同网址的不同标签页具有独立的运行任务，**已保存历史按规范化 URL 共享**，同时写入时最近保存的结果成为该网址历史。URL 规范化去掉跟踪参数并保留 `#/` / `#!` 路由。

## 当前边界

本版完成文档 A / B 的主要能力及 C 的协议与配置接入，**不是全文列出的所有功能都已实现**。

- 不支持 YouTube / B 站字幕提取和视频时间戳；视频专用页会明确提示，不把页面导航当作字幕。
- 暂不提供其他平台 OAuth、云同步、知识库、OCR、通用 PDF 阅读。ChatGPT 为纯扩展的 Codex 兼容授权接入。
- 界面为中文；回答可选中文、英文、跟随正文。
- 暂不提供固定后全站自动展开、跨页自动恢复抽屉、主题切换和独立历史管理页。导航后可再次点击工具栏打开。
- 不调用模型压缩历史，使用确定性的预算缩减；系统会提示，提取内容查看器仍显示缓存原文。
- 模型请求上限 5 分钟，正文缓存上限 120,000 字符，单次回答上限约 200,000 字符；历史保留完整回合，最多约 100 条消息。
- 关闭面板不停止生成；浏览器退出、扩展重载或任务宿主异常仍可中断任务。进行中快照在内存中，最终结果在本地保存。

## 开发与验证

运行 `npm run dev` 后，在 `chrome://extensions` 中手动加载 **`output/chrome-mv3-dev`** 目录，并保持开发服务运行。打开普通网页后点击工具栏中的 Glintab 图标即可显示侧栏。开发服务地址不是插件主界面；`o` 仅重新打开浏览器，不会代替手动加载。修改输出目录后需重启开发服务，并在浏览器中加载新目录。

```bash
npm run dev          # WXT 开发模式，带热更新
npm run compile      # TypeScript 检查
npm test             # 纯函数、协议、任务和仓储测试
npm run build        # 生产构建 + Manifest 权限与产物校验
npm run zip          # 生成扩展分发包
npm run format       # 统一格式

# 浏览器集成测试：先构建，再安装隔离的测试浏览器
npx playwright install chromium
npm run test:e2e
npm run test:e2e:dev # 自动启动隔离的 WXT 开发服务，验证真实开发模式
```

`test:e2e` 启动回环地址上的模拟服务并使用临时 Chromium 配置，不连接个人浏览器、不调用付费模型。仅临时测试副本增加 `127.0.0.1` 主机权限；生产 Manifest 仍使用可选域名权限。该测试验证实际跨上下文链路，不覆盖真实权限弹窗的人工决策。截图和结果在 `artifacts/`。

`test:e2e:dev` 会自动启动独立的开发服务并在结束后关闭，产物放在临时目录，不覆盖你正在使用的 `output/chrome-mv3-dev`。结果位于 `artifacts/development/`。任务 Worker 在开发和生产模式均通过扩展内的 `engine-worker.js` 加载，避免开发服务器的跨源 Worker 引起页面崩溃。修改 Worker 入口后，请在扩展管理页重新加载插件，并刷新原网页后再打开侧栏。

更多说明见 [架构与扩展指南](docs/ARCHITECTURE.md)、[隐私说明](docs/PRIVACY.md)、[验收记录](docs/ACCEPTANCE.md) 和 [迭代路线](docs/ROADMAP.md)。
