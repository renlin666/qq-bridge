# QQ Bridge 项目插件 API v1

从 `0.3.0-rc.1` 开始，项目自身加载功能插件。插件运行在桥接进程中；现有 QQ MCP 仅转发调用，不执行插件入口，也不需要给 DSH 安装新的插件包。

## 安装与启停

项目自带 `extensions/bilibili`、`extensions/image-search`、`extensions/quark`、`extensions/qzone`。原 `integrations`、`webSearch` 配置继续兼容，现有工具名与 `/api/socialV2/integrations/*` 调用保留。`extensions.<id>.enabled` 显式配置优先；功能各自的会话授权、工具开关、图片安全检查和发送账本继续执行。

第三方插件必须放入 `extensions-local/<id>/`，目录默认被 Git 忽略。仅放文件不会执行代码，管理员还必须在 `config.json` 显式启用并授予清单要求的能力。

试用随项目附带的示例：

```powershell
New-Item -ItemType Directory -Path extensions-local -Force
Copy-Item -Recurse examples/extensions/echo extensions-local/echo
```

在现有配置中合并下面字段，保留原有其它配置：

```json
{
  "extensions": {
    "echo": {
      "enabled": true,
      "capabilities": ["messages.read", "messages.send"],
      "config": { "prefix": "收到：" }
    }
  }
}
```

重启桥接，并重连现有 QQ MCP，使模型刷新工具清单。示例工具名为 `qq_ext_echo_echo`；管理员可在已准入会话发送 `/echo:ping 你好` 测试命令。示例默认不安装、不发送消息，工具调用仅回传文字；只有明确使用命令才会请求发送。

控制台侧栏「功能插件」打开通用管理页。配置字段由插件 `configSchema` 生成，保存会校验并持久化。停用立即拒绝新调用、取消在途 SDK 调用并释放资源。启用与完整应用新配置需要重启桥接；工具清单需要重连 MCP。第一版不支持卸载模块后的热重载。

## 插件清单和入口

每个插件提供 `plugin.json` 与 `index.js`。`id` 为小写字母开头的字母、数字、连字符，最长 48 字符；清单 ID 必须与目录相同。清单含独立的语义化 `version`、`apiVersion: 1`、入口、`capabilities`、配置 JSON Schema、工具 JSON Schema。

第三方工具名必须为 `qq_ext_<id中的连字符换成下划线>_<名称>`，最长 64 字符。参数保留 `key`、`token` 给宿主，插件不能重复声明。工具清单是唯一元数据来源：宿主验证它并提供给 MCP，入口只按名称注册处理函数。

```js
export function activate(ctx) {
  ctx.tools.register('qq_ext_example_lookup', async (args, call) => {
    call.assertAuthorized();
    return { text: args.text, key: call.key };
  });
}
```

完整可复制的清单和入口见 `examples/extensions/echo/`。必须注册清单内所有工具，不能注册未声明的名称。入口加载失败、API 不匹配、权限不足、工具冲突或初始化超时，插件会标为失败并回滚注册，基础聊天继续运行。

## 能力接口

| 接口 | 用途与约束 |
| --- | --- |
| `ctx.config` | 当前插件自己的配置副本，不含整个项目配置或令牌 |
| `ctx.tools.register(name, handler, {toMcp})` | 注册清单工具；默认将结果序列化为 MCP 文本，可选择提供多模态格式化函数 |
| `ctx.events.on('message', handler)` | 需要 `messages.read`；接收经过会话准入、提问/审批及静默处理的消息副本；不能修改原消息 |
| `ctx.commands.register(name, handler, {allowMembers})` | 命令为 `/<插件ID>:<名称>`，默认仅管理员可用，不覆盖 `/reset` 等核心命令 |
| `ctx.scheduler.every(ms, handler)` | 需要 `scheduler`，最小 1000ms；任务不重叠，停用清理定时器 |
| `ctx.storage.get(name, fallback)` / `.set(name, value)` | 插件独立 JSON 状态，位于 `state/extensions/<id>/`；名称不可含路径，写入使用临时文件替换，损坏文件拒绝覆盖 |
| `ctx.onDispose(fn)` | 注册同步或异步清理函数，失败回滚、停用及正常退出时调用 |
| `call.key` / `.isOwner` / `.messageId` | 经核心认证的来源会话及消息身份；插件工具调用不自动具有管理员身份 |
| `call.signal` / `.assertAuthorized()` | 取消信号及实时授权检查，异步处理期间也应使用 |
| `call.messages.get(messageId)` | 需要 `messages.read`，只读当前会话仍在最近/未读窗口中的消息 |
| `call.messages.send(messages, requestId)` | 需要 `messages.send`，只发当前会话；复用核心发送队列、配额、审计、真实回执和持久化幂等账本，不需要跨会话共享授权 |
| `call.service('network.read', {url, maxBytes})` | 需要 `network.read`，通过现有 SSRF 防护读取公开网页文本，不接受任意请求头、Cookie 或本地路径 |

`requestId` 必须为 8～100 位字母、数字、下划线或连字符。发送前按插件 ID 隔离该编号；相同编号重试返回已有结果，重启也不会重发。检查返回的 `sent`、`status` 和 `receipts`；`uncertain` 或 `partial` 不代表全部发送成功。示例根据真实来源消息 ID 生成稳定编号。

内置能力 `media.bilibili`、`drive.inspect`、`images.search`、`images.send`、`qzone.social` 是已有受控服务的适配器；插件不能借此获得任意 OneBot 请求接口。内置空间轮询由插件定时器管理，保留原发布、评论账本，不重置历史或待核实请求。

## 权限和运行边界

宿主在读取、服务调用、返回结果及排队发送临近写出时校验授权。QQ 智能体拿不到插件管理接口或项目配置；目录接口只返回工具元数据。工具统一通过已有 QQ MCP 命名空间暴露，原工具守卫继续生效。

同进程 JavaScript 插件是**受信代码**。SDK 能力与存储命名空间不是操作系统沙箱，插件仍可自行导入 Node 模块。超时会取消 SDK 调用与后续受控操作，不能强制中断死循环或任意底层网络请求。不应安装不可信插件；未来需要支持时，必须另做进程和 OS 权限隔离。

## 验证与参考

运行 `npm run test:extensions` 检查加载、失败隔离、目录越界、配置校验、权限撤销、停用取消、定时器、存储、MCP 转发，以及真实本地 HTTP/消息调度链。测试使用临时文件和假 QQ/DSH，不发送真实消息。

生命周期设计参考 [Fastify Avvio 的加载、失败与关闭模式](https://github.com/fastify/avvio#how-avvio-works)，使用本项目已有服务实现最小宿主，没有引入新的 Web 框架。
