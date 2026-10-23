# QQ 社交能力更新记录

更新时间：2026-10-23，Asia/Hong_Kong。

## 已实现并在本机启用

- 真实 QQ 头像：`qq_get_avatar` 返回 MCP 图像内容块，可查看自己或当前会话已出现人物；固定角色形象仍使用 `qq_get_self_image`。
- 共同记忆：既有白名单会话获得共享授权；按 QQ 号关联人物，支持共同经历、查询和删除。原有群友印象在能确认身份时同步，编辑/清除同步到共享层；同名人物不会继承已绑定另一 QQ 号的印象。群话题和原始聊天仍留在所属会话。
- 窗口协作：列出授权目标、交接摘要、唤醒接收窗口、处理后确认。持久化收件箱支持中断恢复，requestId 和冷却限制避免重复与反复唤醒。
- 空间配图：可选择当前聊天消息中的图片、公开 HTTPS 图片、固定角色形象。图片失败则不发布；发布后读回图片数量，`imagesVerified` 明确区分已发布与配图确认。
- 空间评论：读取自己的说说及评论，发表评论、回复真实评论。仅对已有空间授权启用；轮询周期 120 秒，新评论交给发布会话或授权的主人私聊。首次检查静默建立基线，旧评论可按需读取；机器人自己的评论不触发回复。

桥接已重启；DSH 的 QQ MCP 子进程已重新连接，未重置 DSH 会话。重启前后 5 个会话映射一致。

## 验证结果

- 相关离线测试：30/30 通过（社交扩展 15、原集成 7、MCP 模型视图 8）。均使用临时状态与模拟 QQ 接口。
- 初始提示词相关检查通过；新增的协作/评论首次唤醒仍走 bootstrap，保留原初始提示词机制。
- 本机真实只读链路：MCP → 桥接 → QQ 头像/空间接口通过。头像返回 JPEG、40136 字节；49 个工具可发现；当前窗口可列出 4 个其他授权窗口；读取到 3 条说说与首条说说的 1 条评论。
- 评论监测已为 3 条说说建立基线，无待投递事件。
- 未做真实图文发布、真实评论提交或真实回复提交；这些写路径已用模拟接口测试，仍需实际使用核验账号侧结果。

验证记录：`state/feature-live-verification.json`、`state/feature-targeted-final.log`。

全量审计为 36/39 个脚本通过，另有 3 项与本轮功能无关的既有问题：

1. `test-audit-setup-guards.mjs`：现存 `start.bat` 不满足 CRLF 行尾断言。
2. `test-preset-prompt.mjs`：原提示词改写的 CRLF 保留断言失败。
3. `test-voice-system.mjs`：仓库缺少 `docs/guides/VOICE.md`。

完整输出见 `state/feature-audit-final.log`。DSH 工具来源检查通过指定本机解包的 `DSH_TOOL_PACKAGES` 路径运行；未修改工具权限边界。

## 修改位置和备份

- `src/social-hub.js`：共享记忆、人物身份、头像、窗口交接。
- `src/qzone-social.js`：说说/评论读取、回复、轮询、持久化去重。
- `src/qq-integrations.js` / `src/mcp-qq-integrations.js`：扩展路由、图片来源和 MCP 工具。
- `src/bridge.js` / `src/mcp-snowluma-safe.js`：接线、提示词及人物 QQ 号参数。
- `scripts/test-social-extensions.mjs` / `scripts/verify-social-readonly.mjs`：离线回归与真实只读验证。
- `config.json`：只对原白名单与原空间授权开启能力；示例配置默认关闭共享和评论互动。

修改前备份：`state/feature-backup-<timestamp>`。备份含当时配置，属于本机私有资料，不应公开上传。

## 参考实现

- [onebot-qzone](https://github.com/Gu-Heping/onebot-qzone)：头像、图片上传、评论参数及新评论去重设计。
- [dsh-qqchat](https://github.com/Coffeiz/dsh-qqchat/blob/main/docs/ARCHITECTURE.md)：会话记忆与稳定人物身份分层。
- [codex-qq-bot](https://github.com/gl813788-byte/codex-qq-bot/blob/main/docs/FEATURES_CN.md)：按 QQ 号组织跨会话人物记忆的设计。

当前实现继续使用本机已安装 SnowLuma；没有另装 AstrBot 或替换 QQ 接入框架。
