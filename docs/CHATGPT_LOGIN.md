# 使用 ChatGPT 账号

## 使用步骤

1. 构建并在扩展管理页重新加载 Glintab。更新增加了 `webNavigation` 权限，用于观察登录回调。
2. 进入「添加供应商 → ChatGPT 账号登录 → 使用 ChatGPT 登录」，允许访问 OpenAI 授权和 ChatGPT 模型域名。
3. 在新标签页完成账号选择与授权。扩展会自动交换凭证，并将标签页替换为「ChatGPT 授权完成」。
4. 回到设置，选择获取到的模型并点击「保存连接」，然后在普通网页摘要或提问。

不需要运行 `npm run auth:bridge`，也没有需要安装或保持运行的本机组件。内部直接保存必要凭证，不需要把 `auth.json` / `config.toml` 文本粘贴回表单。旧版依赖本机 bridge 的连接需删除后重新登录；旧 `.glintab/auth.json` 不会被读取、迁移或自动删除。

## 查看和编辑 auth.json

在 ChatGPT 供应商配置页，`auth.json` 文本框显示扩展当前保存的账号凭证，可复制、粘贴或直接编辑。编辑后点击「保存连接」才生效；「重新读取」取得后台最新版本并替换未保存内容。复制会将完整令牌写入系统剪贴板。添加 ChatGPT 供应商时也可直接粘贴 JSON，填写名称和模型后手动保存，无需先走浏览器登录。

支持 `tokens` 中的 `id_token / access_token / refresh_token / account_id`；`auth_mode` 可省略或为 `chatgpt`，`OPENAI_API_KEY` 可省略或为 `null`。展示的 `expires_at` 是扩展附加的有效期元数据；JWT 访问令牌优先使用自身的 `exp`，非 JWT 访问令牌需保留有效的 `expires_at` 日期字符串。只存解析后的必要字段，不保存粘贴原文或未知字段。

保存会检查 ID token 的签名、发行方、客户端及导入凭证内部的账号一致性；作为缓存身份信息的 ID token 可以已过期，访问令牌到期后仍按现有流程刷新。使用粘贴按钮或系统粘贴快捷键后点击「保存连接」，会用粘贴内容覆盖整套凭证，包括 ID token、访问令牌、刷新令牌和账号 ID，支持切换到其他账号；供应商条目和模型设置保留。默认的账号名称随新邮箱更新，自定义名称保留。明确粘贴替换会重新建立凭证记录并清除旧记录的本地失效状态；直接编辑旧内容则不能原样恢复失效的刷新令牌。保存不额外调用刷新接口，实际令牌是否已被撤销仍由服务端在使用时校验。

读取和提交凭证仅允许设置页调用专用受控接口。普通配置、会话、事件及侧栏不会包含完整凭证。直接编辑旧内容时如后台已刷新凭证，会拒绝旧版本覆盖并保留未保存文本；明确粘贴替换则以粘贴内容为准，无需先重新读取。替换后新请求使用新凭证，旧任务不会在重试时自动改用新账号。关闭表单不保存编辑，也不改动本机 Codex 的 `auth.json`。

## 登录完成后出现 HTTP 400

「ChatGPT 授权完成」表示令牌交换、身份验证和本地保存已经成功。随后设置页会自动加载模型列表，模型目录请求失败不等于登录失败。

Codex 模型目录需要 `GET /models?client_version=<兼容目录版本>`，并携带 access token 与账号 ID。Glintab 使用配置中的 `CHATGPT_CATALOG_VERSION` 指定目录兼容版本，与插件版本号分开维护，不依赖本机安装 Codex。旧版遗漏查询参数，可能导致登录完成后获取模型列表返回 400。

此版本保留已授权连接并显示具体的模型列表错误。可点击「获取模型」重试，成功后自动选择第一个可见模型；也可以填写账号实际支持的模型 ID 并保存，无需为了目录错误重复登录。模型请求只使用服务端返回或用户填写的 ID，不硬编码模型名称。

## 技术流程与边界

此实现是 **Codex 兼容接入**：使用公开 PKCE 客户端 ID，授权地址为 `https://auth.openai.com/oauth/authorize`，令牌交换与刷新地址为 `https://auth.openai.com/oauth/token`，模型后端为 `https://chatgpt.com/backend-api/codex`。它与 OpenAI 当前文档中的动态注册 OSS 客户端流程不同，不能将其视为已验证的通用 OpenAI API 接口。

每次登录生成独立的 verifier、SHA-256 challenge、state、nonce。固定回调为 `http://127.0.0.1:1455/auth/callback`。后台绑定登录标签页，校验完整 origin、端口、路径及 state。通过导航事件捕获授权码，以 pendingUrl / url 状态查询兜底，**不在回调端口启动监听器**。浏览器短暂出现回调连接失败不代表 OAuth 失败；捕获后会转入扩展自己的完成页。授权服务器是否接受该客户端与回调组合，仍需真实账号验证。

令牌交换后验证 ID token 的签名、issuer、audience、过期时间与 nonce，读取已验证的账号 ID。重连时要求账号身份一致。令牌不写入日志、供应商配置、界面响应或会话快照。

登录参数通过后台 Repository 写入浏览器 session 存储，后台重启后可恢复尚未消费的流程；浏览器退出会清除未完成登录。交换中断不复用旧授权码。取消、关闭登录标签页、超时与重复回调均有独立处理。

## 存储、刷新与退出

OpenAI 凭证由后台 Repository 写入浏览器扩展本地存储的 `chatgpt-auth:<id>`，未加密。网站内容脚本不能访问。配置只持有连接 ID 和 email，生成 Worker 只取得临时 access token 与账号 ID。

请求前检查过期时间；接近过期时串行刷新。401 按凭证版本刷新并重试一次，403 不循环刷新。刷新前持久化失效标记；网络结果不确定、后台中断或轮换后保存失败时要求重新登录，避免使用旧 refresh token。停止生成可以立即结束对刷新结果的等待。

关闭设置不会终止已发起的阅读任务。未保存的授权连接会在取消或过期时清理；浏览器重启时清理未保存记录。删除供应商或清除全部数据会删除本地凭证，远程授权与会话需在 OpenAI 账号设置中管理。

## 验证范围

行为测试使用模拟签名身份验证 PKCE、回调来源、nonce/audience、后台恢复、刷新去重、轮换持久化失败、取消与重连身份校验。浏览器测试使用隔离的 Chromium、模拟授权端点和无人监听的回调端口，不使用真实账号、不调用付费模型。

真实 OpenAI 登录、客户端/回调组合、账号/地区/工作区策略、模型列表与首轮真实推理均仍需人工联调。模拟通过不能替代平台适配验收。

参考：[OpenAI 模型目录协议](https://learn.chatgpt.com/docs/model-catalogs)、[Chrome 导航事件](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)、[Chrome 标签页 URL 与 pendingUrl](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[OpenAI Codex 身份验证](https://learn.chatgpt.com/docs/auth)、[OpenAI OSS 客户端流程（不同接入）](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。
