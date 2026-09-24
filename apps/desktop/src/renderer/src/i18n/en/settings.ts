/** 页面字典(以中文原文为 key,缺译回退中文) */
export default {
  /* ---- 顶栏 / 侧栏导航 / GROUP_LABEL ---- */
  设置: 'Settings',
  通用: 'General',
  'LLM 来源': 'LLM Sources',
  '引擎（Provider）': 'Engines (Providers)',
  '引擎(Provider)': 'Engines (Providers)',
  队列与资源: 'Queue & Resources',
  存储与项目: 'Storage & Projects',
  模型下载: 'Model Downloads',
  '加速 LoRA': 'Accelerated LoRA',
  '🚀 加速 LoRA': '🚀 Accelerated LoRA',
  '引擎引导向导…': 'Engine Setup Wizard…',
  本地优先: 'Local First',
  '不自动上传任何数据；云端 LLM 仅在显式配置凭据后启用。':
    'Nothing is uploaded automatically; cloud LLMs are enabled only after you explicitly configure credentials.',

  /* ---- 通用 ---- */
  外观: 'Appearance',
  '跟随系统（当前：浅色）': 'Follow system (currently: Light)',
  系统: 'System',
  浅色: 'Light',
  深色: 'Dark',
  语言: 'Language',
  界面文案语言: 'Language of the UI text',
  启动时恢复上次项目: 'Restore Last Project on Launch',
  多标签页并发时带项目锁标记: 'Shows a project lock marker when multiple tabs are open',
  'SSD 流式读权重（--ssd-streaming）': 'SSD Streaming Weights (--ssd-streaming)',
  'h3 视频生成专用 · 省 RAM（峰值≈6GB）但慢约 30%；64GB+ 默认关更快，内存紧张（OOM/被系统杀进程）时再开':
    'h3 video generation only · saves RAM (peak ≈6GB) but ~30% slower; keep it off on 64GB+ machines — enable it when memory is tight (OOM / killed by the system)',

  /* ---- LLM 来源:分组头 ---- */
  'LLM 来源（Agent 内核 · Pi Harness）': 'LLM Sources (Agent Core · Pi Harness)',
  仅列出支持工具调用的模型: 'Only models with tool-calling support are listed',

  /* ---- LLM 来源:本地运行时 ---- */
  '本地 · LM Studio（默认，自动发现）': 'Local · LM Studio (default, auto-discovered)',
  '选择要加载到 LM Studio 的模型': 'Select a model to load into LM Studio',
  '本地 · Ollama（自动发现）': 'Local · Ollama (auto-discovered)',
  '选择 Ollama 加载的模型': 'Select the model for Ollama to load',
  '本地 · pi-mlx-provider（免 LM Studio）': 'Local · pi-mlx-provider (no LM Studio needed)',
  '@sinamtz/pi-mlx-provider · MLX-VLM server · Apple Silicon 直跑':
    '@sinamtz/pi-mlx-provider · MLX-VLM server · runs natively on Apple Silicon',
  '选择 pi-mlx 加载的模型': 'Select the model for pi-mlx to load',
  加载模型: 'Load Model',
  '加载中…': 'Loading…',
  未加载: 'Not loaded',
  '加载模型中…': 'Loading model…',
  '探测中…': 'Probing…',
  未检测到: 'Not detected',
  '已就绪 · 模型按需下载': 'Ready · models downloaded on demand',
  '已连接 · 模型自动发现': 'Connected · models auto-discovered',
  '显存预估 ≈ {v} GB / {total} GB 统一内存 · 与生成引擎共享':
    'Estimated VRAM ≈ {v} GB / {total} GB unified memory · shared with the generation engines',
  'MLX 原生 4bit · 免代理直跑 · 支持工具调用与识图（VLM）· 首次加载自动从 HuggingFace 拉取':
    'MLX native 4bit · runs directly, no proxy · supports tool calling and vision (VLM) · auto-pulls from HuggingFace on first load',
  '原生 API :11434 · 兼容 OpenAI /v1 · 发现 {n} 个支持工具调用的已装模型 · 热加载切换约 8s':
    'Native API :11434 · OpenAI /v1 compatible · found {n} installed models with tool-calling support · hot-swap load takes ~8s',
  '发现 {n} 个本地模型 · 单模型驻留显存，切换时自动卸载旧模型（约 20s · 首次 Metal 预热）':
    'Found {n} local models · one model stays resident in VRAM; switching auto-unloads the old one (~20s · first Metal warm-up)',
  '尚未加载模型 —— 请先在下方的「加载模型」中选择要驻留的模型':
    'No model loaded — first pick the model to keep resident via "Load Model" below',

  /* ---- LLM 来源:OpenAI 兼容端点 ---- */
  '本地 · OpenAI 兼容端点': 'Local · OpenAI-compatible Endpoint',
  'vLLM / llama.cpp 等兼容端点，如 http://127.0.0.1:8000/v1':
    'Compatible endpoint such as vLLM / llama.cpp, e.g. http://127.0.0.1:8000/v1',
  测试连接: 'Test Connection',
  '连接中…': 'Connecting…',
  '已连接 · {n} 个模型 · v1 兼容': 'Connected · {n} models · v1 compatible',
  连接失败: 'Connection failed',
  选择要使用的模型: 'Select the model to use',
  选择模型: 'Select Model',
  未选择: 'Not selected',
  '已保存到本机钥匙串 ••••••••': 'Saved to the local Keychain ••••••••',
  'sk-… · 仅存本机钥匙串': 'sk-… · stored only in the local Keychain',
  保存: 'Save',
  保存失败: 'Save failed',
  '请先「测试连接」并在下方选择模型': 'Please "Test Connection" first, then select a model below',

  /* ---- LLM 来源:云端 Provider ---- */
  '云端 Provider（可选增强）': 'Cloud Providers (optional enhancement)',
  '按供应商管理凭据与模型 · 均为 OpenAI 兼容协议 · 凭据仅存本机钥匙串':
    'Manage credentials and models per provider · all use the OpenAI-compatible protocol · credentials are stored only in the local Keychain',
  尚未配置云端供应商: 'No cloud providers configured yet',
  '{n} 个模型': '{n} models',
  '启用 / 停用': 'Enable / Disable',
  检查: 'Check',
  '检查中…': 'Checking…',
  '连接正常 · v1 兼容': 'Connection OK · v1 compatible',
  '未设置 API Host': 'API Host not set',
  '模型 · {n}': 'Models · {n}',
  '＋ 添加模型': '＋ Add Model',
  '尚未添加模型 —— 添加后会出现在画布 Agent 的模型选择器中':
    "No models added yet — once added, they appear in the canvas Agent's model picker",
  '当前 LLM 来源': 'Current LLM source',
  '点击设为当前 LLM 来源': 'Click to set as the current LLM source',
  移除模型: 'Remove model',
  '删除该供应商(连同本机钥匙串凭据;不影响已生成的画布内容)':
    'Delete this provider (including its local Keychain credentials; generated canvas content is not affected)',
  再点一次确认删除: 'Click again to confirm deletion',
  删除供应商: 'Delete Provider',
  '＋ 添加供应商': '＋ Add Provider',
  '请先添加云端供应商并选择模型': 'Please add a cloud provider and select a model first',
  项目级覆盖: 'Project-level Override',
  '每个项目可单独指定 LLM 来源（项目设置面板）；未配置本地模型时自动回退云端，或纯模板 + 手工（AI-optional）。':
    'Each project can specify its own LLM source (project settings panel); without a configured local model it falls back to the cloud automatically, or runs template-only + manual (AI-optional).',
  选择要加载的本地模型: 'Select a local model to load',

  /* ---- 弹层:添加供应商 / 添加模型 ---- */
  添加供应商: 'Add Provider',
  '均为 OpenAI 兼容协议': 'All use the OpenAI-compatible protocol',
  关闭: 'Close',
  已添加: 'Added',
  添加模型: 'Add Models',
  '添加模型 · {name}': 'Add Models · {name}',
  重新拉取模型列表: 'Refetch model list',
  '拉取中…': 'Fetching…',
  '{n} 个模型 · 刚刚更新': '{n} models · just updated',
  加载失败: 'Load failed',
  '正在从 {ep} 拉取模型列表…': 'Fetching model list from {ep}…',
  模型清单加载失败: 'Failed to Load Model List',
  该供应商未返回可用模型: 'This provider returned no usable models',
  该供应商未返回可枚举的模型清单: 'This provider did not return an enumerable model list',
  全选: 'Select All',
  '已选 {n} 个': '{n} selected',
  添加所选: 'Add Selected',

  /* ---- 引擎(Provider) ---- */
  '引擎（Provider 注册表）': 'Engines (Provider Registry)',
  真实推理: 'Real Inference',
  '关闭时一律用占位引擎演示，秒回；开启后引擎就绪则真实生成（慢）':
    'When off, placeholder engines demo everything instantly; when on and an engine is ready, generation runs for real (slow)',
  'h3.c（视频主引擎）': 'h3.c (primary video engine)',
  '模型目录 ~/models/h3 · 144GB · 带声直出 · 能力：文生/首帧/尾帧/首尾帧/Ref2VA/参考视频音频':
    'Model dir ~/models/h3 · 144GB · direct output with audio · capabilities: text-to-video / first frame / last frame / first+last frames / Ref2VA / reference video & audio',
  '默认 · 视频': 'Default · Video',
  'mlxgen（图片主引擎）': 'mlxgen (primary image engine)',
  'Z-Image-Turbo 默认 · Qwen Edit / FLUX.2 Klein / SeedVR2 · 模型按需下载':
    'Z-Image-Turbo by default · Qwen Edit / FLUX.2 Klein / SeedVR2 · models downloaded on demand',
  '默认 · 图片': 'Default · Image',
  管理模型: 'Manage Models',
  'ComfyUI（补充引擎）': 'ComfyUI (supplementary engine)',
  'http://127.0.0.1:8188 · 仅 localhost · 导入 workflow_api.json（krea2 可直接导入）':
    'http://127.0.0.1:8188 · localhost only · import workflow_api.json (krea2 can import it directly)',
  未连接: 'Not connected',
  连接: 'Connect',
  '未响应 · 稍后可在向导中安装': 'No response · you can install it later via the wizard',
  重试: 'Retry',
  '备选视频：mlxgen Wan2.2 / Bernini-R': 'Backup video: mlxgen Wan2.2 / Bernini-R',
  '资源空闲时可用；能力差异在节点 UI 可见（不支持的模式禁用）':
    'Available when resources are idle; capability differences are shown in the node UI (unsupported modes are disabled)',
  可选: 'Optional',
  启用: 'Enable',
  '已启用 ✓': 'Enabled ✓',
  已就绪: 'Ready',
  '已就绪 · {v}': 'Ready · {v}',
  异常: 'Error',
  检测: 'Detect',

  /* ---- 队列与资源 ---- */
  视频槽位: 'Video Slot',
  '同一时刻一个 h3 任务 · FIFO': 'One h3 job at a time · FIFO',
  图片槽位与视频槽位互斥: 'Image and Video Slots Are Mutually Exclusive',
  '64GB 内存策略 · 不并发双引擎': '64GB memory policy · never run both engines concurrently',
  预览档优先插队: 'Preview Tier Jumps the Queue',
  需用户确认后执行: 'Executed after user confirmation',
  '首次 Metal 预热提示': 'First-run Metal Warm-up Notice',
  '约 30 分钟 · 档位防呆白名单已启用': 'About 30 minutes · tier safeguard whitelist enabled',
  已提示: 'Acknowledged',

  /* ---- 存储与项目 ---- */
  数据目录: 'Data Directory',
  '~/.bigbotart · SQLite（node:sqlite）+ 本地媒体目录': '~/.bigbotart · SQLite (node:sqlite) + local media directories',
  '更改…': 'Change…',
  项目锁: 'Project Lock',
  '多标签页并发锁（参考 H3Mise）': 'Multi-tab concurrency lock (ref: H3Mise)',
  '画布 JSON 导出 / 导入': 'Canvas JSON Export / Import',
  '可复现：每个 Take 记录完整参数 + seed + 引擎版本':
    'Reproducible: every Take records full parameters + seed + engine version',
  导出: 'Export',

  /* ---- 模型下载 ---- */
  '按需下载 · 断点续传': 'Download on demand · resumable',
  'LLM · 推荐': 'LLM · Recommended',
  '文生图 · 推荐 · ~11GB': 'Text-to-image · Recommended · ~11GB',
  '指令编辑 / Inpaint · 推荐 · 37.5GB': 'Instruction editing / Inpaint · Recommended · 37.5GB',
  '多参考生成/编辑 · Outpaint · ~18GB': 'Multi-reference generation/editing · Outpaint · ~18GB',
  '超分修复 · 可选 · ~4.7GB': 'Upscaling & restoration · Optional · ~4.7GB',
  '视觉 LLM · Agent 识图 · 可选 · ~16.6GB': 'Vision LLM · Agent image understanding · Optional · ~16.6GB',
  下载: 'Download',
  下载中: 'Downloading',
  取消下载: 'Cancel Download',
  已取消: 'Cancelled',
  重新下载: 'Download Again',
  下载失败: 'Download failed',
  下载出错: 'Download error',
  未下载: 'Not downloaded',
  启动下载失败: 'Failed to start download',
  下载启动失败: 'Failed to start download',
  '已取消 · 保留断点续传': 'Cancelled · resumable download kept',
  取消失败: 'Cancel failed',
  '更多：GLM-4 / DeepSeek / Llama 3.x / Mistral / Phi / Gemma 3 / MiniCPM…（§5.2.4 清单）':
    'More: GLM-4 / DeepSeek / Llama 3.x / Mistral / Phi / Gemma 3 / MiniCPM… (§5.2.4 list)',

  /* ---- 加速 LoRA ---- */
  '蒸馏模型包 · h3.c -d 加速目录(非 .safetensors)': 'Distilled model packs · h3.c -d acceleration directory (not .safetensors)',
  蒸馏模型包管理: 'Distilled Model Pack Management',
  '镜头开启「加速 LoRA」时 -d 换用所选包目录 + 4/8 步 · 默认包在镜头未选包时兜底(手册 §8)':
    'When a shot enables "Accelerated LoRA", -d switches to the selected pack directory + 4/8 steps · the default pack is the fallback when a shot picks none (manual §8)',
  '{a}/{b} 就绪': '{a}/{b} ready',
  '还没有模型包 · 在下方安装(如手册 §1.2 的 MiniMax-H3-turbo-T8test 目录)':
    'No packs yet · install one below (e.g. the MiniMax-H3-turbo-T8test directory from manual §1.2)',
  ' · 默认': ' · Default',
  '推荐 {n} 步': 'Recommended {n} steps',
  就绪: 'Ready',
  目录缺失: 'Directory missing',
  设默认: 'Set as Default',
  删除: 'Delete',
  安装模型包: 'Install Model Pack',
  '名称,如 MiniMax-H3-turbo-T8test': 'Name, e.g. MiniMax-H3-turbo-T8test',
  推荐步数: 'Recommended steps',
  '{n} 步': '{n} steps',
  安装: 'Install',
  请填名称与目录路径: 'Please fill in the name and directory path',
  '已安装「{name}」· 登记完成(文件未拷贝)': 'Installed "{name}" · registered (files not copied)',
  安装失败: 'Install failed',
  '已删除登记(磁盘文件保留)': 'Registration removed (files kept on disk)',
  删除失败: 'Delete failed',
  操作失败: 'Operation failed',
  '目录须存在且含 FL2VA/(turbo 目录结构);登记不拷贝文件,删除只注销不删磁盘 · h3.c 不接受 --lora, 此为蒸馏模型包加速(手册 §8)':
    'The directory must exist and contain FL2VA/ (turbo layout); registering copies no files and deleting only unregisters · h3.c does not accept --lora — this is distilled-pack acceleration (manual §8)',

  /* ---- lm-select 弹层 ---- */
  '显存 ≈ {v} GB': 'VRAM ≈ {v} GB',
  ' · 需下载': ' · download required',
  已加载: 'Loaded',
} satisfies Record<string, string>;
