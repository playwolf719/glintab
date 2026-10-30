# Glintab 0.1.0 发布材料

目标：Chrome Web Store。发布者：**playwolf719**；公开联系：**playwolf719@gmail.com**。准备日期：2026-10-30。

## 材料索引

| 材料                                                               | 用途                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [中文商店文案](STORE_LISTING_ZH.md)                                | 名称、简短说明、详细说明、首发更新说明                             |
| [隐私实践与权限申报](PRIVACY_PRACTICES.md)                         | 单一用途、9 项权限、可选域名、远程代码和数据类型                   |
| [审核员说明](REVIEWER_GUIDE.md)                                    | 英文审核步骤、外部模型配置与本地演示方法                           |
| [隐私政策源文档](../PRIVACY.md) / [HTML 版本](privacy-policy.html) | 公开托管后填写隐私政策网址；两份内容保持一致                       |
| [发布者资料](publisher.json)                                       | 名称、邮箱及待补充的公开网址                                       |
| `assets/`                                                          | 128px 图标、4 张 1280×800 真实界面截图、440×280 和 1400×560 宣传图 |
| `assets/manifest.json`                                             | 图片尺寸、SHA-256 和截图来源说明                                   |
| `output/glintab-0.1.0-chrome.zip`                                  | 上传到商店的生产扩展包（不要上传整个仓库或材料包）                 |
| `output/glintab-0.1.0-store-materials.zip`                         | 文案、政策和图片的材料归档，不用于安装                             |

## 重新生成

```bash
npm run check
npm run zip
npm run release:materials
npm run format
npm run format:check
```

`release:materials` 基于已有 `output/chrome-mv3` 生成 HTML 隐私政策、图片和材料 ZIP，不更改生产 Manifest。需要 Playwright Chromium；缺失时先执行 `npx playwright install chromium`。自定义浏览器缓存路径时，生成和验收均需设置相同的 `PLAYWRIGHT_BROWSERS_PATH`。

图片脚本使用临时浏览器配置和扩展副本，仅为该副本授予回环地址权限；正文提取、后台仓储、Worker 与 React 界面均来自生产构建。示例文章原创，模型是明确标注的固定本机响应，不接入个人浏览器，不使用真实密钥，也不展示尚未验收的视频平台画面。宣传图沿用项目原创图标，以包内图形和 CSS 绘制，不使用其他项目素材。

## 上传顺序与待办

- [ ] 注册并完成 Chrome 开发者账号的验证；确认发布者显示名。
- [ ] 将 `privacy-policy.html` 托管到公开 HTTPS 地址，使用未登录窗口检查可以打开，再更新 `publisher.json` 的 `privacyPolicyUrl`。**目前尚无公开隐私政策 URL。**
- [ ] 如有官网或支持页面，再填真实地址；邮箱已准备好，不能用本地文件路径充当网址。
- [ ] 准备审核可用的外部模型配置/限额凭证（当前尚未提供），填入商店私有 Test instructions；不要公开真实密钥。
- [ ] 对照 [验收记录](../ACCEPTANCE.md)，在日常 Chrome 人工检查站点权限允许/拒绝、中文输入法、真实模型、真实视频字幕与可选转写；未验收的服务不能对外声称已适配。
- [ ] 上传 `output/glintab-0.1.0-chrome.zip`；确认根目录包含 `manifest.json`，版本与文案一致。更新已有商店条目时必须使用更高版本。
- [ ] 填写简体中文商店信息，上传 `assets/icon-128.png` 和编号截图；宣传图为可选项。
- [ ] 逐项填写单一用途、权限理由、数据申报、隐私政策地址和审核说明，确认与实际产物一致。
- [ ] 分发选择免费；地区、可见性和审核后自动发布由发布者在后台选择。建议首次使用审核后手动发布，便于确认展示内容。
- [ ] 提交审核后保存条目 ID、包的 SHA-256、版本与提交日期；审核通过后再公开商店链接。

当前准备工作不包含登录商店、上传条目、提交审核或公开托管。代码中的 ChatGPT 连接和 B 站转写虽有模拟链路验收，仍需实际服务联调，详见验收记录。

## 图片上传顺序

1. `01-reading-summary.png`：网页旁的摘要，展示核心阅读用途。
2. `02-follow-up.png`：围绕同一正文追问。
3. `03-source-inspection.png`：核对提取内容并导出 Markdown。
4. `04-summary-prompts.png`：网页与视频的独立摘要指令。

截图中的示例内容与固定演示模型均有标记；不得宣传成真实模型或平台适配结果。图片生成后应检查内容可读、没有真实凭证和个人数据。

## 官方参考

图片准备为 128×128 PNG 图标、1280×800 截图，最多上传 5 张；可选宣传图为 440×280 与 1400×560。依据 [Chrome 图片要求](https://developer.chrome.com/docs/webstore/images) 和 [商店信息说明](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)。

填写与提交分别参考 [隐私字段](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)、[审核说明](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions) 和 [发布流程](https://developer.chrome.com/docs/webstore/publish)。核对日期：2026-10-30。
