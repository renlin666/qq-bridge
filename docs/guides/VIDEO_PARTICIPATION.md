# 视频分享参与规则

白名单会话中的新B站分享和QQ视频消息触发独立 video 唤醒，不要求@，不依赖普通消息概率、关键词或峰时可选闲聊节流。保留暂停、白名单、合批、忙碌排队及唤醒频率的延后重试；引用旧视频不冒充新视频。合批中的视频也受保护，不因最初的唤醒原因不同而被峰时丢弃。

当前部署门槛180秒，按整段和全部分P总时长校验。超长或时长不明时，在字幕、音视频下载之前停止，只返回标题/简介等元数据，并标记 responseMode=metadata-comment-only、requiresUnwatchedDisclosure=true。机器人仍需自然评价，明确说没有观看，不能编造声音、画面或结局。保留既有指定账号对指定视频的真实许可例外，工具验证原消息；@不是授权。

门槛内默认全时间线取帧、读完整字幕或转写完整实际音轨。多P逐P读取，具体细节可补看片段。fullTimeline 代表画面取样覆盖整段，不代表逐帧观看；音轨转写只识别语音，不代表理解全部音效。没有得到实际内容时明确说明，旧工具失败不应被当作当前功能不可用。QQ原生视频和其他平台暂未接入同等读取工具时，唤醒后也必须明确未观看。

测试：node --test scripts/test-video-participation.mjs scripts/test-video-policy.mjs scripts/test-peak-economy.mjs scripts/test-bilibili-media.mjs scripts/test-media-stream.mjs。Unix socket 客户端测试需在 Linux 执行；真实媒体验证只读取已授权会话内已有视频，不代发QQ消息。
