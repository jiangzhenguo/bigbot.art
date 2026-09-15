# BigBotArt — 无限画布的视频/图片生成 Agent

跨端桌面 App(Electron 31 + 原生 JS/HTML/CSS,Apple HIG + Liquid Glass 设计系统),专门为**本地部署的 h3.c 视频引擎 + MLX 图片生成/编辑引擎**打造创作工作流。产品 PRD 见 [`PRD-BigBotArt-无限画布视频图片生成Agent.md`](PRD-BigBotArt-无限画布视频图片生成Agent.md),调研报告见 [`docs/调研报告-MiniMaxDesign与本地模型接入方案.md`](docs/调研报告-MiniMaxDesign与本地模型接入方案.md)。

## 当前状态:M1 完整应用(原生 JS/HTML/CSS 实现,基于设计系统)

已实现的完整应用闭环:

- ✅ **跨端桌面 App 外壳**(Electron 31 + 原生 JS/HTML/CSS,多页应用)
- ✅ **Apple HIG + Liquid Glass 设计系统**:7 个完整页面(首页/画布/资产/Skills/时间线/设置/引擎引导),视觉与交互完全按设计稿
- ✅ **画布工作台**:9 类节点拖拽/连线/检查器/Agent 面板/队列条(原生 CSS transform 实现,非 React Flow)
- ✅ **一句话起活**:首页输入需求 → Agent 规划(远端 DeepSeek / 本地 LM Studio)→ 生成 Brief + 镜头节点
- ✅ **引擎引导向导雏形**:真实探测 LM Studio(1234)/ Ollama(11434)/ ComfyUI(8188)/ h3.c(--info 读 GPU/Metal/内存)/ mlxgen(command -v)
- ✅ **h3c Provider**(`packages/providers/src/h3c.ts`):命令构造器(32 倍数宽高校验、档位防呆、五段式提示词)+ 后台子进程托管骨架(默认 dry-run,避免骨架期跑 10 分钟推理)
- ✅ **mlxgen Provider**(文生图/指令编辑/I2I/Inpaint/Outpaint/超分能力声明)
- ✅ **Mock Provider**:离线演示,ffmpeg 生成带音轨测试视频(模拟带声直出)
- ✅ **Agent 内核**(`packages/agent`):JSON-RPC over stdio 子进程协议 + pi-ai 真 LLM 规划(远端 DeepSeek / 本地 LM Studio)
- ✅ **项目/画布持久化**(`apps/desktop/src/main/store.ts`):JSON 存储(接口可切换 SQLite)
- ✅ **节点生成按钮**:每个镜头节点有"▶ 生成"按钮,点击调用真实 Provider(当前 mock 模式,`BIGBOTART_DRYRUN=0` 后真实推理)

## 目录结构

```text
apps/desktop/          # Electron 外壳(main/preload/renderer)
  src/renderer/        # 原生 JS/HTML/CSS 页面(Apple HIG + Liquid Glass 设计系统)
    index.html         # 入口(重定向到 home.html)
    home.html          # 首页(一句话起活 + 模型/技能选择 + 附件 + 项目流)
    home.js            # 首页交互逻辑(接入 Agent/项目/引擎探测)
    canvas.html        # 画布工作台(9 类节点 + 拖拽 + 连线 + Agent 面板 + 队列条)
    assets.html        # 资产中心(筛选/搜索/详情/Take 归档)
    skills.html        # Skills 库(模板参数化/派生分支)
    timeline.html      # 时间线/导出(双轨剪辑 + FFmpeg)
    settings.html      # 设置(LLM 来源 / Provider 注册表 / 队列)
    onboarding.html    # 引擎引导向导(探测/安装/下载/自检)
    public/design/     # 设计系统令牌(colors_and_type.css)
    public/assets/     # 演示摄影素材(CC 授权)
    public/build/      # 品牌标记 SVG
packages/shared/       # 领域类型(画布/节点/Shot/Take/Provider/引擎状态)
packages/providers/    # h3c / mlxgen / mock Provider + 注册表 + h3 命令构造器
packages/agent/        # Agent 子进程管理 + 确定性规划(pi 插槽)
```

## 运行

```bash
pnpm install
pnpm dev          # 开发模式(electron-vite dev)
pnpm build        # 构建产物
pnpm start        # electron-vite preview
```

首次启动会自动创建示例项目;引擎引导向导在画布右上角"🛠 引擎引导"。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BIGBOTART_HOME` | `~/.bigbotart` | 项目/画布数据目录 |
| `BIGBOTART_DRYRUN=0` | `1` | 关闭 dry-run,真实调用 h3.c / mlxgen(慢,需模型就绪) |
| `BIGBOTART_H3_OUTPUTS` | `.bigbotart/outputs` | h3 输出目录 |

### 远端/本地 LLM(Agent 规划内核)

Agent 已集成 **pi-ai + 远端 OpenAI 兼容 LLM**(默认 DeepSeek,已实测打通)。按优先级:

1. **远端**(推荐):设置以下环境变量后启动,优先使用
   - `BIGBOTART_LLM_BASE_URL`(如 `https://api.deepseek.com/v1`,任何 OpenAI 兼容端点均可:GLM/Kimi/MiniMax…)
   - `BIGBOTART_LLM_API_KEY`
   - `BIGBOTART_LLM_MODEL`(默认 `deepseek-chat`)
2. **本地 LM Studio**:未配置远端时自动回退 `http://127.0.0.1:1234/v1`(Ornith-1.5)
3. **确定性规划兜底**:LLM 不可达时自动回退模板拆镜,闭环不断

## M1 骨架的已知边界

- **h3.c / mlxgen 默认 dry-run**(只构造命令 + 占位结果);`BIGBOTART_DRYRUN=0` 后走真实推理。
- **Agent 为 pi-ai 真 LLM 规划**(远端/本地),失败回退确定性模板;接入点 `packages/agent/src/pi-planner.ts`。
- **画布持久化为 JSON 文件**;SQLite 方案(接口已抽象)待 Electron 内置 Node 升级或引入 better-sqlite3。
- **macOS Gatekeeper**:从非官方渠道下载的 Electron 二进制可能被系统清除;本仓库已用 `codesign --force --deep --sign -` 做 ad-hoc 签名规避,重装依赖后如遇清除需重新签名(见下)。

### 如果 Electron 二进制被 macOS 移除

```bash
cd node_modules/.pnpm/electron@*/node_modules/electron
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js
codesign --force --deep --sign - dist/Electron.app
```