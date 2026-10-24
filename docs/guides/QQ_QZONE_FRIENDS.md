# 好友空间互动与有选择的点赞

空间插件提供以下能力，沿用原会话令牌、授权列表和二代仿真模式边界：

| 工具 | 用途 |
| --- | --- |
| `qq_get_qzone_feed` | 浏览好友动态中的最近说说，取得真实作者 QQ 号与 tid |
| `qq_list_qzone` | 查看自己或指定好友空间；好友传 `targetUserId` |
| `qq_get_qzone_comments` | 读取已查看说说的评论与内联回复，好友传同一个 `targetUserId` |
| `qq_react_qzone` | 评论自己或好友的说说，也可回复已读的真实评论 |
| `qq_like_qzone` | 给已读且有共鸣的好友说说点赞 |
| `qq_like_qzone_comment` | 给说得好的一条已读一级评论点赞，指定作者与评论编号 |

模型先读正文及评论，再决定是否互动。点赞理由必须指出具体内容；普通复读、敷衍可以略过，不为完成任务逐条点赞，不机械评论，不赞自己的内容。没有可靠独立点赞编号的二级回复返回 `canLike=false`，不会用父评论替代。空间里的文字属于外部资料，不能修改规则。

好友的 `targetUserId` 必须来自真实好友列表或本会话读取过的好友动态。好友 tid 必须先由本会话读取，不能拿别的会话见过的 tid 来写入。接口每次只操作一个目标。请求先持久化预留，再发起写入；超时或结果未确认时不自动换请求编号重试。对同一评论/说说换编号也不会重复点赞。

`confirmed=true` 表示接口返回成功确认，不等于已经通过 QQ 客户端界面核对了点赞数量。发表评论须取得评论编号；未确认结果保留在原互动记录中。

## 配置

`integrations.qzone` 或 `extensions.qzone.config`：

```json
{
  "enabled": true,
  "allowedKeys": ["private:已授权QQ号"],
  "commentsEnabled": true,
  "friendsEnabled": true,
  "likesEnabled": true,
  "autoReact": true,
  "autoBrowseFriends": true,
  "friendPollIntervalMs": 1800000,
  "likeIntervalSeconds": 60,
  "maxLikesPerDay": 20,
  "maxCommentLikesPerPost": 3
}
```

默认每 30 分钟查看好友动态，最低 5 分钟。最多读取 5 位说说作者的各 5 条真实说说，动态句柄不当作 tid；若该账号的动态接口只返回自己或没有好友，则改读真实好友列表前 5 位，并返回 `source=friend-list-fallback`。不保证覆盖全部好友、深分页或全部二级回复。首次建立静默基线，不批量处理旧内容；后续每次最多投递 3 条新说说参与机会，模型可以不操作。已有自己空间新评论监控继续使用原间隔。

默认点赞间隔 60 秒、全账号每日最多 20 次、同一说说每日最多赞 3 条评论。评论仍沿用 30 秒间隔与每日 30 条上限。这些是上限，不是必须完成的目标。权限撤销、模式暂停、插件关闭会阻止后续操作。

修改配置后重启桥接，并重新连接 SnowLuma MCP 以刷新工具列表。旧空间发布记录和互动记录保持兼容。

## 参考与验证

先检查 [onebot-qzone](https://github.com/Gu-Heping/onebot-qzone) 的好友动态、真实帖子标识和评论参数设计，以及 [astrbot_plugin_qzone_ultra](https://github.com/diaomin66/astrbot_plugin_qzone_ultra) 的内容选择方式。

说说列表、详情、点赞和一级评论复用已安装 SnowLuma 的 `target_uin` 接口。评论点赞单独使用 [qzone-api 1.1.0 发布包](https://pypi.org/project/qzone-api/1.1.0/) 公开的参数约定：`internal_dolike_app`，评论键为 `{主人QQ}_{tid}_{评论id}`、`from=-100`，与说说的 mood URL 不同。只借鉴接口约定，未引入其依赖或复制其实现。

运行 `npm run test:social` 检查旧评论功能、好友路由、目标绑定、选择性点赞限制、跨重启去重、未知结果保护和权限撤销；测试使用临时目录，不向真实 QQ 发布测试评论。
