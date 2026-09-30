# Qwen-Image 系列官方提示词使用规范调研报告

> 调研日期:2026-09(会话时间)。所有结论均来自官方一手来源(GitHub QwenLM 仓库、Qwen 官方博客、HF/ModelScope 官方模型卡),社区内容单独标注。未凭记忆编造。

## 0. 核心结论速览

1. **官方确实存在名为「Qwen-Image-2.1」的模型**:GitHub 仓库 `QwenLM/Qwen-Image-2.1`,HF `Qwen/Qwen-Image-2.1`,发布于 **2026-09-20**。本机 `~/ai/models/Qwen-Image-2.1-bf16` 经核对 `model_index.json`(`QwenImage21Pipeline` / `Qwen3VLForConditionalGeneration` / `AutoencoderKLQwenImage21`)**就是该官方 checkpoint**,与官方仓库结构一致。
2. Qwen-Image-2.1 ≠ Qwen-Image-2512:**2512 是 2025-12-31 发布的 20B 文生图月度迭代**;**2.1 是 7B 视觉生成组件的统一文生图+编辑模型**(原生 RGBA、最多 10 张参考图、prefix KV cache)。另有 Qwen-Image-2.0(2026-02-10 发布,主打 2K 原生分辨率与 1k-token 排版指令)。
3. 官方提示词规范的核心:**文字内容用引号包裹 + 指明位置与风格;推荐用官方 Prompt 改写工具/模型;负面提示词官方示例有明确模板;采样参数按变体不同(steps 50→40,true_cfg_scale=4.0)**。

## 1. 模型谱系与「Qwen-Image-2.1」查证(官方)

来源:[QwenLM/Qwen-Image README News 区](https://github.com/QwenLM/Qwen-Image)、[QwenLM/Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1)

| 模型 | 发布 | 性质 | 官方仓库 |
|---|---|---|---|
| Qwen-Image | 2025-08-04 | 20B MMDiT 文生图 | HF `Qwen/Qwen-Image`(Apache 2.0) |
| Qwen-Image-Edit | 2025-08-18 | 基于 20B 的单图指令编辑 | HF `Qwen/Qwen-Image-Edit` |
| Qwen-Image-Edit-2509 | 2025-09-22 | 多图编辑(1–3 张最佳)+ 一致性增强 + 原生 ControlNet | HF `Qwen/Qwen-Image-Edit-2509` |
| Qwen-Image-Layered | 2025-12-19 | 分层生成 | HF `Qwen/Qwen-Image-Layered` |
| Qwen-Image-Edit-2511 | 2025-12-23 | 多人一致性、内置社区 LoRA 效果、几何推理 | HF `Qwen/Qwen-Image-Edit-2511` |
| **Qwen-Image-2512** | **2025-12-31** | **20B 文生图 12 月迭代(人物真实感/纹理/文字渲染增强)** | **HF `Qwen/Qwen-Image-2512`** |
| Qwen-Image-2.0 | 2026-02-10 | 下一代基础模型,原生 2K、1k-token 排版指令(PPT/海报/漫画) | 官方博客 qwen.ai/blog?id=qwen-image-2.0(README News 未给权重链接,主要走 Qwen Chat) |
| **Qwen-Image-2.1** | **2026-09-20** | **7B 单流 DiT(32 层)统一文生图+编辑;原生 RGBA;≤10 张参考图;prefix KV cache;Qwen3-VL 8B 文本编码器(视觉塔编码参考图);64 通道 RGBA VAE 16× 压缩;Flow Matching Euler 调度** | **HF `Qwen/Qwen-Image-2.1` / ModelScope 同名;许可证为 Qwen Research License(注意:非 Apache 2.0)** |

**对本机部署的确证**:`~/ai/models/Qwen-Image-2.1-bf16/model_index.json` 声明 `_class_name: QwenImage21Pipeline`、text_encoder 为 `Qwen3VLForConditionalGeneration`(即带 vision tower,这正是参考编辑用视觉塔编码参考图的来源)、VAE 为 `AutoencoderKLQwenImage21`。与官方 HF `Qwen/Qwen-Image-2.1` 完全一致。**官方确切名称 = `Qwen/Qwen-Image-2.1`(Qwen-Image-2.1)**,不是「2512」也不是「2.x」的别名。

## 2. 文生图提示词规范(Qwen/Qwen-Image,官方)

来源:[GitHub README Quick Start](https://github.com/QwenLM/Qwen-Image)、[官方博客 qwen-image](https://qwenlm.github.io/blog/qwen-image/)、[prompt_utils.py 官方改写系统提示词](https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils.py)

### 2.1 语言与结构

- **中英文都原生支持**,中文文字渲染是官方主打卖点("supports both alphabetic languages (e.g., English) and logographic languages (e.g., Chinese) with high fidelity")。
- 官方示例提示词均为**长结构化自然语言描述**:主体特征(外貌/表情/姿态)→ 场景/背景 → 文字内容与位置 → 光影 → 风格 → 画质词。官方 Prompt 优化师系统提示词(中文)明确要求:"完善用户描述中出现的主体特征(如外貌、表情,数量、种族、姿态等)、画面风格、空间关系、镜头景别",且"改写之后的 prompt 中**不应该出现任何否定词**"。
- 官方提供 `positive_magic` 画质后缀(README Quick Start 原文):
  - 英文:`", Ultra HD, 4K, cinematic composition."`
  - 中文:`", 超清,4K,电影级构图."`

### 2.2 文字渲染写法(引号包裹、中英混排)

官方 prompt_utils.py 的 T2I 改写系统提示词原文规则:

- 英文版:"If the input requires rendering text in the image, **enclose specific text in quotation marks**, specify its position (e.g., top-left corner, bottom-right corner) and style. This text should remain unaltered and not translated"
- 中文版:"如果用户输入中需要在图像中生成文字内容,请把**具体的文字部分用引号规范**的表示,同时需要**指明文字的位置**(如:左上角、右下角等)**和风格**,这部分的文字不需要改写";"如果需要在图像中生成的文字模棱两可,应该改成具体的内容"(如"邀请函上写着名字和日期"→"邀请函的下方写着'姓名:张三,日期:2025年7月'");"除了用户明确要求书写的文字内容外,**禁止增加任何额外的文字内容**"。
- **中英混排**:官方博客案例直接示范同一画面内中英文混排渲染——"她身后的玻璃板上手写体写着 'Meet Qwen-Image – a powerful image foundation model… 欢迎了解Qwen-Image, 一款强大的图像基础模型…'",官方评价"the model can switch between two languages at any time when rendering text"。

### 2.3 官方示例提示词(原文摘录)

① README Quick Start(文字渲染综合):
> A coffee shop entrance features a chalkboard sign reading "Qwen Coffee 😊 $2 per cup," with a neon light beside it displaying "通义千问". Next to it hangs a poster showing a beautiful Chinese woman, and beneath the poster is written "π≈3.1415926-53589793-23846264-33832795-02384197".

② 官方博客(中文长文本渲染):
> 一个穿着"QWEN"标志的T恤的中国美女正拿着黑色的马克笔面相镜头微笑。她身后的玻璃板上手写体写着 "一、Qwen-Image的技术路线: 探索视觉生成基础模型的极限,开创理解与生成一体化的未来。二、Qwen-Image的模型特色:1、复杂文字渲染。支持中英渲染、自动布局; 2、精准图像编辑。支持文字编辑、物体增减、风格变换。三、Qwen-Image的未来愿景:赋能专业内容创作、助力生成式AI发展。"

③ 官方博客(中文海报/PPT 类,节选):
> 一副典雅庄重的对联悬挂于厅堂之中……对联上左书"义本生知人机同道善思新",右书"通云赋智乾坤启数高志远", 横批"智启通义",字体飘逸,中间挂在一着一副中国风的画作,内容是岳阳楼。

### 2.4 采样参数(文生图)

- `num_inference_steps=50`,`true_cfg_scale=4.0`(注意:不是普通 guidance_scale,Qwen-Image pipeline 用 true_cfg_scale)。
- `negative_prompt = " "`(**官方原文:"Recommended if you don't use a negative prompt" —— 不用负面提示词时传单个空格,不是空字符串**)。
- 官方分辨率表(20B 系列,以 1328×1328 为基准):1:1=1328×1328;16:9=1664×928;9:16=928×1664;4:3=1472×1104;3:4=1104×1472;3:2=1584×1056;2:3=1056×1584。

### 2.5 负面提示词默认模板

- **Qwen-Image(20B)官方 README 没有给默认负面提示词内容**,只建议 `negative_prompt = " "`。
- **Qwen-Image-2512 官方 Quick Start 给了明确的中文负面提示词模板**(原文摘录):
  > `低分辨率,低画质,肢体畸形,手指畸形,画面过饱和,蜡像感,人脸无细节,过度光滑,画面具有AI感。构图混乱。文字模糊,扭曲。`
- 2512 同时推荐使用新的提示词增强工具 `src/examples/tools/prompt_utils_2512.py`。

## 3. 指令编辑规范(Qwen/Qwen-Image-Edit 系列,官方)

来源:[GitHub README](https://github.com/QwenLM/Qwen-Image)、[官方博客 qwen-image-edit](https://qwenlm.github.io/blog/qwen-image-edit/)、[Qwen-Image-Edit-2509.md](https://github.com/QwenLM/Qwen-Image/blob/main/Qwen-Image-Edit-2509.md)、prompt_utils.py 的 `EDIT_SYSTEM_PROMPT`

### 3.1 指令写法总原则

官方编辑指令增强系统提示词(Edit Prompt Enhancer)的硬性规则(原文要点):

- **直接、具体(direct and specific)**;模糊指令要补最小充分细节(类别、颜色、尺寸、朝向、位置)。
- 官方示例:"Add an animal" → "Add a light-gray cat in the bottom-right corner, sitting and facing the camera"。
- **替换任务用 "Replace Y with X" 句式**并简述 X 的关键视觉特征。
- **文字编辑:所有文字内容必须用英文双引号 `" "` 包裹,保留原文语言与大小写**;新增与修改文字都按替换任务写:"Replace "xx" to "yy"";仅当用户要求时才指定文字位置/颜色/排版。
- **人物编辑:强调保持核心视觉一致性(种族、性别、年龄、发型、表情、服装)**;表情/美颜/妆容修改必须自然克制("natural and subtle, never exaggerated")。官方示例:"Change the person's hat" → "Replace the man's hat with a dark brown beret; keep smile, short hair, and gray jacket unchanged"。
- **固定模板(官方强制)**:
  - 老照片修复/上色:`"Restore and colorize the photo."`
  - Inpainting:`"Perform inpainting on this image. The original caption is: "`
  - Outpainting:`"Extend the image beyond its boundaries using outpainting. The original caption is: "`
- **多图任务必须指明"哪张图的哪个元素"**:"Replace the girl of picture 1 with the boy of picture 2, keeping picture 2's background unchanged"。
- README 官方 NOTE 原文:"editing results may become unstable if prompt rewriting is not used. Therefore, we **strongly recommend applying prompt rewriting** to improve the stability of editing tasks"(官方改写工具基于 Qwen-VL-Max,`polish_edit_prompt`)。

### 3.2 常见指令类别(官方博客归纳)

- **语义编辑(semantic editing,允许整体像素变化但保持语义一致)**:IP 创作/表情包、新视角合成(物体旋转 90°/180°)、风格迁移(如吉卜力风格)。
- **外观编辑(appearance editing,其余区域必须完全不变)**:增/删/改元素(加招牌并自动生成倒影、去除细小发丝、把字母 "n" 改成蓝色)、换背景、换装。
- **精准文字编辑**:中英文双语增删改文字,**保留原字体、字号、风格**;2509 起还支持改字体、颜色、材质。
- **链式编辑(chained editing)**:官方博客示范用框选标注 + 多轮编辑逐步纠正书法错字("稽"→ 框出"日"部 → 替换为"旨")。

### 3.3 采样参数(编辑)

| 变体 | steps | true_cfg_scale | guidance_scale | negative_prompt |
|---|---|---|---|---|
| Qwen-Image-Edit(单图) | 50 | 4.0 | —(未设) | `" "` |
| Qwen-Image-Edit-2509(多图) | 40 | 4.0 | 1.0 | `" "` |
| Qwen-Image-Edit-2511 | 40 | 4.0 | 1.0 | `" "` |

官方建议:"Qwen-Image-Edit-2509 has better consistency than Qwen-Image-Edit; it is recommended to use Qwen-Image-Edit-2509 directly, for both single image input and multiple image inputs"(2509 多图输入 1–3 张效果最佳)。2511 示例指令(中文、含文字渲染):"这个女生看着面前的电视屏幕,屏幕上面写着'阿里巴巴'"。

## 4. Qwen-Image-2.1 官方提示词规范(本机在用的模型)

来源:[QwenLM/Qwen-Image-2.1 README](https://github.com/QwenLM/Qwen-Image-2.1)、本机 `~/ai/models/Qwen-Image-2.1-bf16/README.md`(即官方 HF 模型卡副本)

- **统一模型**:同一 checkpoint 做文生图与编辑;编辑时把参考图传给 `image=`(单图或多图列表),**最多 10 张参考图**;支持画圈/涂鸦标注/独立 mask 指定局部编辑;支持人物与商品 identity 保持。
- **RGBA 透明图官方推荐提示词模板**(原文):
  > `This is an RGBA image with transparency. <your description>. The image has alpha channel and the background is transparent.`
- **官方示例提示词**(原文摘录):
  ① 文生图:`A neon shop sign that reads "QWEN IMAGE 2.1", rainy night, reflections on wet pavement`(文字依然引号包裹)。
  ② 单图编辑:`Change the background to a sunset beach`。
  ③ 多参考:`These three characters are sitting around a campfire in a forest`。
  ④ vLLM 编辑示例:`Let this mascot dance under the moon`。
- **采样参数**:`num_inference_steps=40`(默认,README 参数表);**原生 2K 分辨率**,官方尺寸表:1:1=2048×2048;4:3=2400×1792;3:4=1792×2400;3:2=2528×1696;2:3=1696×2528;16:9=2752×1536;9:16=1536×2752。Quick Start **未使用 negative_prompt / true_cfg_scale**(与 20B 系列不同);SGLang 官方示例用 `--guidance-scale 1`。
- **官方 Prompt 改写模型(2.1 专属,替代旧 prompt_utils API)**:两个微调 Qwen3.5-VL 9B checkpoint——T2I 用 `Qwen/Qwen-Image-2.1-PE-T2I`,编辑用 `Qwen/Qwen-Image-2.1-PE-I2I`,代码在仓库 `prompt_rewrite/`。输出 JSON 含 `rewritten_prompt` 与 `wh_ratio`(模型自选宽高比);编辑输出还有 `ratio_follow: "<image1>"`(跟随某张输入图的宽高比)。官方定位:"expand short prompts into detailed, high-quality descriptions",**改写后的提示词为英文长描述**。
- **prefix KV cache**:checkpoint `causal_condition: true`(默认)时,text 与条件图前缀跨去噪步自动缓存,多图编辑显著加速(与 CLAUDE.md 中本机实测"kv cache 默认开启"一致)。
- **架构**(提示词相关):文本编码器是 **Qwen3-VL 8B** 视觉语言模型——文本指令与条件图被编码成统一表示,这就是"带 vision tower 支持参考编辑"的官方出处。

## 5. 社区内容(明确区分,非官方)

- ComfyUI 官方(Comfy-Org)Day-0 支持 2.1,权重 `Comfy-Org/Qwen-Image-2.1`,提供 t2i/edit 示例工作流(属 Comfy 团队而非阿里)。
- `mzbac/Qwen-Image-2512-8bit`、`exolabs/Qwen-Image-Edit-2509-4bit`、`ovedrive/...-NF4`、`nunchaku-ai/nunchaku-qwen-image-edit-2509`、GGUF(Replicate)等均为**社区量化导出**,本项目已踩过 `JoyFusionAI/Qwen-Image-2.1-MLX-8bit` 缺 vision tower 的坑(见 CLAUDE.md)。
- LightX2V(Qwen-Image-Lightning 蒸馏 LoRA)、cache-dit、LeMiCa、vLLM-Omni、SGLang-Diffusion、DiffSynth-Studio 等为社区/第三方加速与部署方案(部分在官方 README Community Support 区列出,属官方认可但非官方维护)。

## 6. 对 BigBotArt 的可执行建议(基于以上官方规范)

1. **qwen21(2.1)编辑指令**:沿用官方"直接+具体"风格;替换用 "Replace Y with X";文字用英文双引号;多参考时写清 "picture 1 / 图1" 指代(注意 2.1 的 PE-I2I 用 `<image1>` 记号,改写模型输出约定);步骤默认 40,不低于引擎下限。
2. **2.1 文生图**:需要透明图时套用官方 RGBA 模板句;分辨率优先用官方 2K 表;无 negative_prompt 惯例(可不传)。
3. **20B 系列(Qwen-Image / Edit / 2509)**:steps 50(Edit-2509/2511 为 40)、true_cfg_scale 4.0、negative_prompt 默认 `" "`;需要负面模板时可用 2512 的中文模板;文字渲染一律引号+位置+风格。
4. 旧编辑链路的"prompt rewriting 强烈推荐"在 2.1 上演变为官方 PE-T2I / PE-I2I 微调模型,如需接改写可考虑本地部署这两个 9B checkpoint(官方权重)。
