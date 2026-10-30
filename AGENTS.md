# Glintab 开发约定

- 开始变更前阅读 `README.md` 和 `docs/ARCHITECTURE.md`。
- 技术栈：WXT / Manifest V3 / React / TypeScript。默认中文界面，设备本地存储。
- `entrypoints` 只协调浏览器上下文；规则放 `lib/domain`，提取器放 `lib/extraction`，协议放 `lib/llm`，任务放 `lib/engine`。
- 配置和会话的存储写入经 background 的 `Repository` 完成；抽屉宽度等宿主数据也只由后台写入。不要在 UI 或 offscreen 中直接写 storage。
- 不混淆 pageKey、conversation.id、tabId 和 streamId；修改任务流程必须检查并发、旧事件、停止、重连和持久化失败。
- runtime 内容脚本的空 `matches` 是权限设计，不能为了注入方便改成全站永久权限。
- 新增请求或事件时更新 `types/index.ts`，校验调用上下文与来源。不要把密钥写入日志或保存配置原文。
- 不使用原项目源码或素材；不要编造尚未验证的平台适配结果。
- 重要逻辑使用行为测试；UI 细节不写镜像测试。提交前运行 `npm run check`；跨上下文改动还需 `npm run test:e2e`。
- 用 `npm run format` 保持一致格式。新增功能同步更新边界、验收和隐私文档。
