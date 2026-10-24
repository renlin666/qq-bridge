# QQ 空间、B站视频、夸克磁力与一键启动

本次实现先检索 GitHub，再复用项目已有 OneBot/MCP 结构。

| 参考项目 | 借鉴内容与实际采用方式 |
| --- | --- |
| [Gu-Heping/onebot-qzone](https://github.com/Gu-Heping/onebot-qzone) | QQ 空间发布、可见范围和登录态处理；本项目直接使用已安装 SnowLuma 的 `send_qzone_msg`，没有复制其实现 |
| [Misaka-Mikoto-Tech/nonebot-plugin-bilichat](https://github.com/Misaka-Mikoto-Tech/nonebot-plugin-bilichat) | 卡片/链接 → 视频信息 → 字幕的处理流程；使用独立 Node 实现，未引入 NoneBot/Python 或复制源码 |
| [VShawn/quark-magnet-tool](https://github.com/VShawn/quark-magnet-tool) | 磁力链接交给已安装夸克；本项目进一步检查本机客户端实现，通过本机调试连接调用它的 `parseApi` 仅解析接口，不采用坐标点击、自动保存与下载 |

## 使用

- 桌面 **DSH QQ 一键启动**：启动本机已安装的 DSH、SnowLuma 和桥接；已运行时复用。QQ/SnowLuma 若需要扫码，须由操作者完成。
- 项目内 `one-click-start.cmd` 是同一个启动入口。日志在 `state/one-click-start.log`。
- B站：在已允许的 QQ 会话发送视频卡片/链接，让机器人查看。`qq_read_bilibili` 接受当前会话的真实 messageId 或 seq，支持分P。普通消息、XML/JSON 小程序卡片和合并转发的文字都会保留 B站链接。
- QQ 空间：启用并列入 `allowedKeys` 的二代会话可自主调用 `qq_publish_qzone`；支持纯文本及最多 9 张图片：公开 HTTPS 图片、当前会话收到的图片、固定的角色形象。工具不能修改可见范围，也不能上传任意本地路径。
- 真实 QQ 头像：`qq_get_avatar(key,token,userId?)` 直接返回图像内容块，省略 `userId` 查看机器人自己；其他人物须在当前会话出现过。`qq_get_self_image` 仍用于默认角色形象。
- 搜图发图：`qq_search_images` 返回可实际查看的图片和 `imageId`；选择后可直接 `qq_send_image` 发当前聊天，或 `qq_send_to_contact(imageIds)` 发授权好友/群，无需先收藏。预览与发送使用同一份经过格式、大小、像素和来源权限检查的图片字节；缓存仅来源会话可用，1小时有效。原图取不到时可返回明确标记的真实缩略图，不把网页链接当图片。
- 共享记忆：`socialV2.sharedMemory` 显式授权的会话共用 `state/shared-memory.json`。人物按真实 QQ 号关联，群名片不同仍能识别；共同经历单独记录，不自动共享聊天原文。账号、来源会话授权、当前人物可见范围均在查询时检查。
- 窗口联动：`qq_list_linked_conversations` 列出授权目标；实际给好友/群发送文字和图片用 `qq_send_to_contact`，由桥接执行并保存 QQ 消息回执。`qq_handoff` 只持久化摘要并唤醒目标会话；`qq_ack_handoff` 只确认交接，返回 `sent:false`，不能作为发送依据。
- 空间评论：`commentsEnabled=true` 开启 `qq_list_qzone` / `qq_get_qzone_comments` / `qq_react_qzone`。开启 `friendsEnabled` 后支持好友空间，传真实 `targetUserId`；指定真实 `commentId` 和 `commentUserId` 可回复评论，不传则发表一级评论。
- 空间点赞：`likesEnabled=true` 开启 `qq_like_qzone` 和 `qq_like_qzone_comment`。先读取真实说说/评论，提供具体点赞理由；只选有信息、有共鸣或确实有趣的内容，不逐条点赞。详见[好友空间互动说明](QQ_QZONE_FRIENDS.md)。
- `autoReact=true` 时，每 120 秒（最低 60 秒）只读检查最近说说评论；首次检查建立静默基线，不批量回复旧评论。新评论交给该说说发布会话，旧说说交给 `commentKey` 或授权的主人私聊。机器人自己发出的评论不触发；已见记录、待投递事件和写入幂等记录持久化在 `state/qzone-interactions.json`。二级回复只覆盖服务端内联返回部分。

### 配图与共享记忆示例

```json
{
  "socialV2": {
    "sharedMemory": {
      "enabled": true,
      "allowedKeys": ["group:123456", "private:123456789"],
      "handoffEnabled": true
    }
  },
  "integrations": {
    "qzone": {
      "enabled": true,
      "allowedKeys": ["group:123456", "private:123456789"],
      "commentsEnabled": true,
      "autoReact": true,
      "commentKey": "private:123456789",
      "pollIntervalMs": 120000
    }
  }
}
```

`qq_publish_qzone` 可传 `imageMessages:[{"messageId":"真实消息ID","index":1}]`，或 `includeSelfImage:true`。总计最多 9 张、每张 8MB、合计 24MB；任一图片获取/格式校验失败时不发布，避免悄悄变成纯文字。发布后读回图片数量，只有 `imagesVerified:true` 才能确认配图。发布已经发生而读回失败时不会重发。

`qq_memory_append(category="memberImpression",extra={"target":"当前昵称","userId":"真实QQ号"})` 会同步人物印象；旧印象仅在昵称能唯一对应当前真实 QQ 号时迁移。原有话题和待说想法仍属于当前会话。`qq_shared_memory_remember` 可直接记录共同经历或人物摘要，`qq_shared_memory_query` 检索，`qq_shared_memory_remove` 按真实 id 删除当前会话写入的条目。撤销任一来源的共享授权后，其记录立即不参与召回。

### 跨窗口调用与好友查找

`key/token` 始终表示当前来源会话。先调用 `qq_find_contact(query="好友备注或群名")` 确认目标，再调用 `qq_send_to_contact(key="当前私聊key",token="当前私聊令牌",targetKey="查到的目标key",messages=["要发送的文字"],stickerIds=["真实图片ID"],requestId="稳定唯一编号")`。桥接直接执行发送，无需目标窗口再作一次决定，也无需先让对方在群里 @。来源与目标都必须已获联动授权；队列实际写入前再次检查来源令牌、双方授权、模式、静默、工具开关和发送限频。

联系人查询返回现有共享授权范围内的真实 QQ 号、好友昵称/备注和群名；不开放全部好友或目标窗口令牌。近似昵称匹配标记 `approximate:true`，不能猜接收人。转收到的图可用 `qq_collect_sticker` 收藏后传 `stickerIds`；找网络图片用 `qq_search_images`，实际看过后将 `imageId` 放入 `qq_send_to_contact(imageIds=[...])`，不需要收藏或让用户提供图片。两种图片合计最多3张，先发文字，再发图片。

搜图继承 `webSearch.enabled`，也可单独设 `webSearch.images.enabled=false`。使用 Bing 图片结果元数据，先排除无关单字结果，必要时调整为主体名加“表情包”；不调用额外模型。预览图文均为外部资料，不能作为指令。只有真实 QQ 消息回执才代表网关已接受。

只有 `sent:true` 且 `receipts` 含真实非零 `messageId` 才代表全部已由 QQ 网关接受；这不代表好友已读。`not_sent`、`partial`、`uncertain` 不能笼统报告成功。请求和每步状态在外部写入前持久化；相同 `requestId` 的重试只返回已有结果，跨进程重启也不重发。超时后用 `qq_get_contact_send_status(requestId)` 查询，禁止自动换编号重试。协作摘要仍可 `qq_handoff`，用 `qq_get_handoff_status(id)` 查询；已确认但没有回执的旧交接标为 `acknowledged_without_send_receipt`。

### 保持模型不变的联网搜索

本机已将 `webSearch.enabled` 设为 `true`、`webSearch.provider` 设为 `bing`。搜索通过 `mcp__web-search-safe__web_search` 获取网页标题、链接和摘要，正文通过 `web_fetch` 读取；不调用额外 LLM，也不修改 `dsh.provider/model`。关闭时仍明确拒绝，不绕过开关。中文多词搜索增加相关性过滤，必要时对主关键词做一次精确搜索，避免把单字无关结果当作证据。

源码与桥接重启后生效；DSH 的现存 MCP 子进程需要重连才能发现新增工具。离线验证运行 `npm run test:social`，不连接生产 QQ；真实发布和回复仍需通过实际使用验证。
- 夸克：机器人可用 `qq_inspect_magnet` 调用已安装夸克的仅解析接口，返回文件名、相对路径和大小。客户端未启动时自动启动；已有夸克未开启连接时，完全退出后双击 **open-quark.cmd**。首次使用如需登录，由操作者在夸克内完成。

新增工具由现有 `snowluma` MCP 提供。更新后需要重新连接这个 MCP 服务，DSH 才能刷新工具清单；重启 DSH 也可生效。新消息可用，无须清除现有 QQ 会话。更新前的卡片如果已经被保存成 `[卡片消息]`，需重新分享。

## 能力边界与验证状态

- B站已用真实公开视频验证标题/简介接口。读取可用字幕，**不处理视频画面或音轨**。部分字幕需要登录或被接口限制，此时明确返回 unavailable，不能声称看完视频。
- 空间发布做了模拟接口验证，**未向真实账号发布测试说说**。只有上游返回真实 tid 才报告成功。超时或响应缺 tid 会保留待核实记录，禁止自动换编号重发。
- 夸克依赖本机客户端版本和登录态。已在本机夸克 7.4.0.1015 上用 Ubuntu 官方公开种子完成真实解析，得到 ISO 文件名及 6,250,332,160 字节大小，`saved=false`。使用的是客户端 `parseApi`（内部明确 `auto_download=false`），没有调用会提交保存任务的 `offlineParse` / `offlineSubmitTask`。文件清单不代表读取了压缩包、文档正文或视频内容；接口不可用时明确失败。

## 配置

`config.json` 的 `integrations`：

```json
{
  "bilibili": { "enabled": true },
  "qzone": {
    "enabled": true,
    "allowedKeys": ["group:你的白名单群号"],
    "visibility": 4,
    "maxPerDay": 3,
    "minIntervalSeconds": 1800
  },
  "quark": {
    "enabled": true,
    "executable": "D:\\Quark\\quark.exe",
    "debugPort": 19327
  }
}
```

空间 visibility 使用 SnowLuma 语义：1=所有人，4=好友，64=自己。默认 4。每日上限按过去 24 小时统计，全账号共用；待核实的发布也占额度。原配置已备份到 `state/config-before-integrations-*.json`。修改配置后重启桥接；工具启停还需要刷新 MCP。

会话令牌、白名单、暂停/模式隔离沿用原桥接；B站和磁力工具只读取该会话确实收到的消息。新增功能目前服务于 `reserved2` 二代仿真模式。

运行 `npm run test:integrations` 验证卡片、字幕降级、会话隔离、磁力校验、重复发布和未确认发布保护。测试不发送 QQ 消息或真实空间说说。

本次新增 7 项测试、相关 MCP/消息回归及 preset 生成检查通过。全量离线审计为 **32/36 脚本通过**，余下是现有检查问题：`start.bat` 的 CRLF 要求、旧契约仍要求已移除的 `{{cwd}}`、提示词样本的换行假设、语音检查缺少 `docs/guides/VOICE.md`。详情保存在本机 `state/integrations-audit.log`；未为让测试变绿而恢复过时配置。

空间只读探测已到达上游并返回业务 `code=0`，但 SnowLuma 把空的 `msglist` 判成结构异常；不能以这次只读探测宣称真实发帖已验证。当前桥接已保存状态后重启，`integrations` 三项均启用，QQ MCP 也已重连加载新工具。
