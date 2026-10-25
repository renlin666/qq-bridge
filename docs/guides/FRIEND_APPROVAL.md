# 好友申请与空间访问诊断

`QZONE_NOT_FRIEND` 表示桥接在访问空间前按好友范围拦截，不是 QQ 空间返回的权限错误。好友列表损坏或接口失败必须单独说明，不能猜测对方设置。

当前发言人亲自邀请看空间或添加好友时，机器人可以调用 `qq_request_friend_approval(targetUserId,messageId,reason)`。工具检查当前会话中24小时内的原消息、真实发信人和 QQ 账号，不能替第三人申请。它将对象、来源会话、原因和唯一编号私聊给 **配置的 ownerQQ 管理员**；可以向对方说明需要审批。

管理员在 **config.ownerQQ 对应的管理员私聊**独立回复：

```
同意加好友 <16位申请编号>
拒绝加好友 <16位申请编号>
```

审批不接受群聊同意、转述同意、其他人的同意或模型自行推断。批准24小时有效。一次批准只对应一个对象和一次客户端尝试。

状态分别是 `pending_approval`、`approved`、`dispatching`、`request_submitted`、`friends`。`notifiedAdmin` 只确认审批私聊的消息回执；`requestSubmitted` 才代表 QQ 界面确认提交，`isFriend` 必须由真实好友列表确认。

批准后如果来源会话或好友审批授权被撤销，尚未执行的申请转为 `cancelled_authorization`，不再自动恢复；后台继续处理其他有效申请，不让撤权记录阻塞队列。读取好友列表的临时网络失败保留批准状态，不能误报为已经添加。

遇到验证问题/验证码暂停为 `paused_verification`；界面无法识别为 `paused_ui`；发送或进程中断且结果不明为 `uncertain`。这些状态都不会自动重试，管理员通过 noVNC 核实/处理。不提供自动绕过验证、自动重发或批量加好友。7天内同账号同对象不重复提案，最多每天5个提案。加好友后不会自动增加私聊白名单。

## 云端执行器

`scripts/cloud/friend-ui.py` 通过 QQ 图形界面执行；SnowLuma 公开版没有主动申请 action，`set_friend_add_request` 是处理入站申请。参考上游：https://github.com/SnowLuma/SnowLuma/issues/480 。没有采用缺乏成功证据的自制发包方式。

执行器文件安装到 `/usr/local/lib/qq-stack/friend-ui/`，root 所有且不可由 qqbot 修改。系统依赖 `python3-pil`、`tesseract-ocr`、`tesseract-ocr-chi-sim`；容器使用现有 Python、X11/XTest 和 `xwininfo`，不更换 SnowLuma 镜像。服务配置见 `scripts/cloud/qq-friend-ui.service`。

桥接通过 `/run/qq-friend-ui/control.sock` 传入**唯一申请编号**，不能传鼠标坐标、命令、路径或文字。执行器验证 Unix peer UID、持久化批准记录、当前 QQ 账号、授权会话和时效；点击添加前再次验证完整目标QQ号。点击前写 root 专用记录，重启和重复调用都不能再发。遇到界面变化停止操作。普通模型不拥有本地执行或桌面工具。

桥接状态：`state/friend-requests.json`。执行器去重和裁切取证：`/var/lib/qq-stack/friend-ui/`（root专用）。同时操作 noVNC 可能改变界面；执行申请时应避免手动操作。现有适配器要求1280×720桌面及已验证的QQ窗口布局，变化后暂停等待人工核实。

验证：`npm run test:friends` 覆盖审批身份、去重、会话限制、验证暂停、发送结果与好友关系分离。`python3 scripts/test-friend-ui.py` 离线覆盖号码前后缀、OCR数字拼接、身份歧义、按钮归属及点击前对象变化；不操作真实QQ。执行器只接受明确QQ字段的完整相等匹配，以及该结果行内唯一的添加按钮，点击前再次校验。服务器执行 `python3 /usr/local/lib/qq-stack/friend-ui/friend-ui.py --dry-run <QQ>` 只搜索并验证完整QQ号及添加按钮，停在点击前。
