# audio-extract 示例插件

从画布输入视频中提取第一条音轨，输出 16-bit PCM、48kHz、立体声 WAV。

- 插件 id：`bigbotart-examples`
- 节点局部 kind：`audio-extract`（注册后完整 kind 为 `plugin:bigbotart-examples:audio-extract`）
- 输入：`input-video`，单值、必填、媒体类型为 video
- 主输出：`audio`，媒体类型为 audio
- 参数：`format`，默认 `wav`

## 安装与运行

在 BigBotArt 的插件入口中显式选择本文件夹。应用会读取并校验 `manifest.json`，然后把插件复制到数据目录的版本化插件目录；不会执行 `npm install`，也不会修改或删除这个源文件夹。

运行时只依赖系统可执行文件 `ffmpeg`（必须在 `PATH` 中），没有 npm 依赖。每次运行使用独立的 Take 输出目录，插件只收到参数、已解析输入路径和本次输出目录等受限上下文。

这是纯本地媒体处理，**不会触发 AI 推理**。`dryRun` 不会把本地转码变成虚假的成功结果；ffmpeg 失败或没有生成有效文件时，本次 Take 会明确失败。
