# QQ 原生记忆冲突与额外整理回合：修复记录

## 原因

DSH 的 `meow-memory@0.31.0` 在全局注册原生 `memory_*` 工具和记忆指南，并会在连续工具操作后触发额外反思回合。QQ preset 的执行期白名单拒绝这些原生工具，但原先没有隐藏它们的 schema，也没有替换全局指南，因此模型仍会尝试调用、收到拒绝，再改用 QQ 记忆工具。

日志确认 2026-10-23 11:51:03 的 `memory_remember` 被拒绝，11:51:17 的 `qq_memory_append` 成功。本次问题是重复尝试和两套记忆流程冲突，不是桥接记忆丢失。

## 修改

- QQ preset 在工具注册期隐藏8个可选原生工具：`memory_remember/search/find_similar/read/update/project/home/dream`。执行期白名单继续拒绝原生工具，保留 QQ MCP 记忆接口与已有权限边界。
- 使用 DSH 官方的作用域覆盖机制，仅替换 QQ preset 继承的 `meow-memory:guide`，改为简短的 QQ 记忆说明。其他 DSH 会话继续使用原生指南。
- 使用已安装喵记忆插件支持的 `/meow-memory/skip-dreams` 接口，按会话设置 `dream/inject/write` 三个跳过标记：关闭 QQ 会话的自动 dream/反思、原生记忆注入与原生写入。没有直接修改数据库，也没有关闭全局插件。
- 已应用到现有5个 QQ 会话。桥接启动时核对已有会话，在新建/复用受限 QQ 会话及黑话学习会话时自动应用；成功结果缓存10分钟，避免每条消息重复写设置。`closed-agent` 新会话不应用此规则。
- 插件未安装时允许正常 QQ 运行，短暂缓存接口不存在的结果；接口出错会记录并在后续重试，不伪报设置成功。QQ 工具白名单始终保持。

`qq_memory_*` 与 `qq_shared_memory_*` 继续保存当前会话及授权共享摘要。既有桥接记忆和原生记忆条目没有删除，模型与平台未切换。

## 验证与节省范围

专项8项通过，验证原生工具隐藏/拒绝、QQ 记忆保留、作用域指南覆盖、可选插件缺失、并发去重、错误响应、现有/新建 QQ 会话及首条 prompt 前的配置时机。

全量审计40/43个脚本通过。其余仍是此前的 `start.bat` 行尾、预设 CRLF 保留、缺少 `VOICE.md` 三项问题，没有新增失败。

真实只读检查确认：5个 QQ 会话的3个跳过标记全部生效，其他会话的记忆范围设置未变化；模型选择与会话映射一致，原生插件仍对其他会话启用，全局 profile 文件字节内容未变化。QQ preset 通过现有 HMR 机制重载，桥接已重启加载自动配置逻辑，没有重启整个 DSH。

节省来自少传不可用工具定义和原生指南、避免拒绝后改走另一工具、减少额外整理回合。没有进行相同负载下的计费 token 对照，因此不声称具体节省比例或金额。本次验证没有提交模型测试请求，也没有向 QQ 发送测试消息。

证据：`state/native-memory-targeted.log`、`state/native-memory-audit.log`、`state/native-memory-live-verification.json`。备份：`state/feature-backup-<timestamp>`，其中 `meow-scopes.json` 保存修改前的原生会话设置。

## 恢复

需要恢复时，先还原备份源码并重载桥接与 QQ preset，再按 `meow-scopes.json` 通过原生接口逐会话恢复三个标记。当前备份中的5个 QQ 会话原先均未设置跳过标记；分别 POST `field=dream/inject/write,value=false` 即恢复默认参与。先恢复源码是为了避免桥接再次自动应用跳过规则。不要删除记忆数据库或整个会话目录。
