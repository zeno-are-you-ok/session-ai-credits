# Session AI Credits

Session AI Credits 是一个用于 GitHub Copilot CLI 会话的 canvas 扩展，可查看当前会话的 Token 与 Credits 使用情况。

## 功能

- 汇总当前会话的 AI Credits、模型调用数，以及服务端输入/输出 Token。
- 按模型和 Agent 展示 Credits、调用数与 Token 用量。
- 以图表展示当前上下文和历史快照的 Token 分类；当前图表会显示用量/窗口比值、模型容量、空闲空间和缓冲区。
- 展开轮次可查看逐次模型调用、Credits、输入/输出与缓存 Token、调用类型、上下文快照，以及相关工具和 Skills 活动。
- 使用 K/M/B/T 格式显示大数值，并可刷新当前数据。

## 适用条件

需要使用支持 canvas 扩展的 GitHub Copilot App，并且当前 Copilot CLI 会话运行时提供用量、事件和上下文归因 API。Credits、上下文或历史事件未提供时，对应数据会标记为不可用或不完整；扩展不会根据累计数字反推缺失的逐轮明细。

面板由绑定到 `127.0.0.1` 的本地 HTTP 服务提供。已记录的会话用量事件保存在当前 session workspace 的 `.session-ai-credits-ledger.json` 中，不会发送到第三方服务。

## 安装

在 Copilot App 中打开 **Import canvas from gist/URL**，粘贴下面的扩展目录 URL 并导入：

<https://github.com/zeno-are-you-ok/session-ai-credits/tree/main/extension>

导入后，在 Copilot App 的 canvas 中打开 **Session AI Credits**。

## 许可

本项目采用 MIT License，详见 [LICENSE](LICENSE)。
