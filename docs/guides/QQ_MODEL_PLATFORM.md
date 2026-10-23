# 本项目的模型平台和自动续写

QQ 桥接已配置为只使用：

- API 基址：`https://maas.qianwenaiapi.com/compatible-mode/v1`
- 首选模型：`deepseek-v4.1-flash-1017`
- 故障切换顺序：`deepseek-v4.1-flash`、`deepseek-v4-flash-0731`、`vanchin/deepseek-v4.1-flash`。
- DSH 专用供应商路由：`qq-qianwen`，模型目录只包含以上 DeepSeek Flash 型号。
- 密钥：保存在本机 DSH 凭据引用 `QQ_QIANWEN_API_KEY`，不写入仓库或普通配置。

`config.json` 的 `dsh.exclusiveModel=true` 表示：每次使用 QQ 会话或黑话学习会话前重新确认模型；首选不可用时按白名单顺序切换，全部失败就停止，不沿用其他平台或其他系列模型。当前路由未声明思考强度选项，因此 `reasoningEffort=null`，请求不携带该参数。

`qq-platform-policy.mjs` 作为本机 DSH 插件加载，仅作用于此专用供应商。每个新步骤先请求 1017；请求失败且平台重试耗尽后，依次尝试其他 Flash 型号。单次输出允许最多 32768 token。DSH 报告 `max-tokens` 时，自动排入“继续”请求，保留原会话内容；一次任务最多自动续写 6 次，用户新指令、停止、正常完成和普通错误不会触发续写。

桥接等待自动续写结束后合并文本再转发，保留工具发送成功标记，避免重复自动转发。续写提示也明确要求不重复已成功的工具操作。发布说说另有持久化幂等记录。达到续写次数上限仍未完成时停止继续消耗，普通聊天模式保留并发送已有输出。此机制没有放宽平台真实的上下文窗口上限。

原联网搜索使用 DeepSeek 官方 Anthropic 兼容接口，不能直接当作当前平台的 OpenAI 兼容接口使用。因此已设置 `webSearch.enabled=false` 并关闭黑话自动联网研究，既不请求官方模型，也不回退 Bing。已有网页链接仍可抓取，QQ、B站和本机夸克接口继续正常使用。

不删除用户其他 DSH 供应商配置；固定路由用于本项目。DSH 的选模 API 也会更新全局默认模型，这是 DSH 的既有行为。

已验证平台 `/models` 含精确模型 ID，真实 `/chat/completions` 调用返回同一模型，并将现有项目会话统一切换。配置变更前的备份保存在本机 `state/`；凭据备份位于原凭据目录，均不用于公开提交。

回归检查：`npm run test:exclusive-model`、`npm run test:continuation`、`npm run test:integrations`。这些测试使用隔离的临时配置，不访问真实平台、不发送 QQ 消息。

真实 DSH 端到端验证：独立会话使用同一平台的 1017 模型，把输出上限设为 64 token、续写次数设为 2，观测到 3 次 max-tokens 回合结束和 2 条自动续写用户消息。测试配置随后移除，正式配置恢复为 32768 token / 6 次。诊断结果保存在本机 state/auto-continuation-probe-result.json。
