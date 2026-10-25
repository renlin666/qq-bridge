# Linux 2 GiB 部署配置

使用 Linux 服务器和 DSH Web 后台运行方式，管理界面在其他设备的浏览器中打开。
部署实例仍需要实际内存与连续运行验证；交换空间只用于缓解短时峰值。

将以下字段合并到目标机器配置，保留原白名单、角色与权限设置：

```json
{
  "integrations": {
    "quark": { "enabled": false },
    "bilibili": {
      "enabled": true,
      "lowMemory": true,
      "ffmpegPath": "/usr/bin/ffmpeg",
      "defaultFrameCount": 4,
      "maxVideoSeconds": 180,
      "fullTimeline": true,
      "transcribe": true,
      "speechSocketPath": "/run/qq-stack-speech.sock"
    }
  },
  "extensions": { "quark": { "enabled": false } }
}
```

低内存视频模式限制为全进程一个任务；繁忙时明确拒绝，调用方不要自动无限重试。
任务启动时进程可用内存不足 128 MiB 会暂缓，错误会列出可用值和所需值。Node.js 的可用值已计入 cgroup 限额（含 systemd 的 MemoryHigh）；MemoryHigh=256M 时不能再要求剩余 256 MiB，否则所有视频都会被拒绝。Linux cgroup v2 下会计入可回收的干净文件缓存，并以主机 MemAvailable 和进程约束值封顶；匿名、共享、脏页和写回页不计入这部分余量。无法读取时保守使用 Node.js 原值，避免连续抽帧后因缓存误判永久不可用。128 MiB 是流式下载、480p 单线程抽帧的准入余量，不是内存峰值的保证，需要配合系统监测。
选择短边不超过 480、长边不超过 854 像素的 AVC 源视频，兼容横屏和竖屏 480p，流式写入私有临时文件，单轨最多 32 MiB；校验通过后才进入缓存。
继续执行公网地址验证、固定 DNS、逐跳重定向检查及 MP4/DASH 文件头校验。
普通补看片段最多抽取 6 帧；开启 fullTimeline 后默认每两秒及尾部一秒窗口取帧，按顺序合成 4×4 联系表，180 秒视频约 6 张联系表。授权长视频增大间隔，将图片总数控制在约 6 张。画面仍属采样，不能声称逐帧看完。解码和滤镜单线程；低清源和帧使用独立缓存文件名。
缓存清理目标为 128 MiB；正在使用的当前视频保留。

低内存模式通过单独的 qq-stack-speech.socket / qq-stack-speech.service 开启本地音轨转写。没有 speechSocketPath 时仍不在桥接进程内加载语音模型。服务复用 DSH 的 SenseVoice int8 + Silero VAD，单线程、12 秒语音分段，一次一项任务；每次结束杀掉模型子进程，只保留轻量 socket 服务。独立 cgroup：MemoryHigh=512M、MemoryMax=640M、MemorySwapMax=256M，启动识别前主机至少有384MiB可用内存。套接字仅 qqbot/root 可读写，不新增公网接口，也不上传音轨到第三方识别服务。

安装脚本中的两个 systemd 单元，启用 qq-stack-speech.socket，模型目录 /opt/qq-stack/models/sensevoice/ 放置已校验的 model.int8.onnx、tokens.txt、silero_vad.onnx。来源及 API 可参照 [sherpa-onnx 官方文档](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)。复用现有 DSH runtime 的 worker，不在机器人本地开发目录启动生产实例。

整段音轨先转换为16kHz单声道PCM WAV，再转写全部音轨。返回 audioSeconds、wholeTrack、transcriptTruncated；没有清晰语音时不编对白。音乐、歌声、动物叫声及中英混合可能误识别，结合实际画面核对。读取/转写失败、字幕截断或声音缺失时必须明确说明限制。多P要逐P读取；整段门槛使用全部分P总时长，不能截短绕过。
保留现有视频时长、真实消息许可和会话权限检查，不通过分段规避观看门槛。
浏览器管理端、OneBot 和远程桌面绑定回环地址，通过 SSH 隧道访问。

验证包含真实流式下载、大小超限、私网重定向、断流清理、缓存不覆盖，以及原视频权限回归。
实际部署还需验证 QQ 扫码登录、真实收发、重启恢复、长时间负载和磁盘回落。
详情接口返回 HTTP 412 且已有有效 BV 号时，改读 B站公开分P列表取得真实 CID 和全部分P时长；任何分P时长或编号无效即拒绝，仍按整段总时长校验。此路径返回 metadataStatus=partial，不补造标题、作者或简介；字幕、视频流继续从原接口读取。
