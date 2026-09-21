# MiniMax-H3 加速 LoRA 使用手册

> **环境**：M5 Pro 64GB Apple Silicon Mac / macOS / h3.c (antirez fork) / MiniMax-H3 系列模型
> **目标**：用蒸馏 LoRA 把 h3.c 出片从 20 步降到 4-8 步，省 60-80% 时间
> **适用对象**：其他 AI agent 或需要手动跑片的人类

---

## TL;DR — 给最急的人

加速"LoRA"在 h3.c 生态里有 3 种用法，但 **`h3.c CLI 不直接接受 --lora` 参数**（源码 0 hit，`--help` 也没列）。最快上手的是：

```bash
cd /Users/jiangzhenguo/ai/h3/h3.c
nohup ./h3 \
  -d /Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo-T8test \
  --width 576 --height 1024 \
  --frames 124 --steps 8 --layers 50 --reuse 1 \
  --first-frame /path/to/ref.jpg \
  --prompt '你的 prompt' \
  -o out.mp4 &
disown
```

跑完接超分（`realesrgan` wrapper）+ CodeFormer 修脸就行。

---

## 1. 工具清单（绝对路径）

### 1.1 h3.c 二进制
| 项 | 路径 |
|---|---|
| 源码 | `/Users/jiangzhenguo/ai/h3/h3.c/` |
| 可执行 | `/Users/jiangzhenguo/ai/h3/h3.c/h3` |
| 帮助 | `./h3 --help` |

### 1.2 模型权重目录
| 项 | 路径 | 用途 |
|---|---|---|
| 原版 base | `/Users/jiangzhenguo/ai/h3/MiniMax-H3/` | 20 步出片 |
| **turbo 蒸馏** | `/Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo/` | **4-8 步蒸馏 base**（推荐）|
| **turbo T8test** | `/Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo-T8test/` | **更新变体**（2026-09-19 实测用这个）|
| Ref2VA 模型 | `/Users/jiangzhenguo/ai/h3/MiniMax-H3/Ref2VA/` | 用 `--ref-image` 时加载 |

turbo 目录结构（节省磁盘）：

```
MiniMax-H3-turbo/FL2VA/
├── transformer/         ← 真实蒸馏权重（替换 base）
├── audio_vae/           → symlink → ../../MiniMax-H3/FL2VA/audio_vae
├── model_index.json     → symlink
├── processor/           → symlink
├── text_encoder/        → symlink
├── tokenizer/           → symlink
└── video_vae/           → symlink
```

### 1.3 加速 LoRA 文件
| 文件 | 大小 | 格式 | 用途 |
|---|---|---|---|
| `~/ai/h3/turbo-lora/minimax_h3_turbo_v4_step600_ema.safetensors` | 780 MB | ComfyUI | v4 蒸馏 LoRA（600 步 EMA）|
| `~/ai/h3/t8star-lora/minimax_h3_turbo_4step_ema_comfyui.safetensors` | 780 MB | ComfyUI | 4 步 LoRA（ComfyUI 命名）|
| `~/ai/h3/t8star-lora/minimax_h3_turbo_4step_ema_comfyui_stripped.safetensors` | 780 MB | Diffusers | 删 `diffusion_model.` 前缀版 |
| `~/ai/h3/t8star-lora/strip_prefix.py` | 1.5 KB | 工具 | ComfyUI → Diffusers key 重命名 |

### 1.4 后处理工具
| 工具 | 路径 | 用途 |
|---|---|---|
| `realesrgan` wrapper | `/Users/jiangzhenguo/bin/realesrgan`（在 PATH 里） | 2x 超分（Metal 加速）|
| `realesrgan-ncnn-vulkan` | `/Users/jiangzhenguo/realesrgan/realesrgan-ncnn-vulkan` | ncnn Vulkan/Metal 二进制 |
| GFPGAN | `/Users/jiangzhenguo/ai/GFPGAN/inference_gfpgan.py` | GAN 修脸（狠但容易变脸）|
| CodeFormer | `/Users/jiangzhenguo/ai/CodeFormer/inference_codeformer.py` | Transformer 修脸（保真度可调）|
| `superres` venv | `/Users/jiangzhenguo/venvs/superres/bin/python` (Python 3.14) | GFPGAN/CodeFormer 跑这里 |
| 模型权重 | `/Users/jiangzhenguo/ai/weights/{GFPGANv1.4,codeformer,detection_Resnet50_Final,parsing_parsenet}.pth` | |
| face-fix | `/Users/jiangzhenguo/ai/face-fix/face_fix_video.py` + `face_fix_video_ref.py` | 整合工具（MPS 加速）|
| face-fix venv | `/Users/jiangzhenguo/ai/face-fix/.venv/bin/python` (Python 3.11) | |

---

## 2. 核心事实（必读）

### 2.1 h3.c 不接受 LoRA 参数

- `h3.c` 源码 `grep -nE "lora|LoRA|LORA"` → **0 hit**
- `h3 --help | grep -i lora` → **0 hit**
- 加速机制 = **蒸馏过的 base model + 少步数**，**不是 LoRA 挂载**

如果你看到用户/朋友说"h3.c 用 LoRA"——他在说 **"用法 1：换 -d 到 turbo 目录 + --steps 8"**，不是真挂 LoRA。

### 2.2 步数与模型匹配

| 步数 | 推荐模型 | 实测质量 |
|---|---|---|
| 4 步 | `MiniMax-H3-turbo-T8test` 或 turbo | 边缘细节略糊 |
| **8 步** | `MiniMax-H3-turbo-T8test` 或 turbo | **质量够用，省 60-70%** ⭐ |
| 16-20 步 | 原版 `MiniMax-H3` 或 turbo 都行 | 稳定 |
| 30+ 步 | 原版 | 边际收益小 |

### 2.3 first-frame vs ref-image

**互斥**（h3.c 报错 `"full references cannot be combined with frame anchors"`）：

| 场景 | 用什么 |
|---|---|
| 单段，首帧锁定动作起点 | `--first-frame ref.jpg` |
| 单段，用参考图锁定人物/角色 | `--ref-image ref1.jpg --ref-image ref2.jpg ...` |
| **多段拼接** | seg1 用 `--ref-image`；seg2+ 用 `--first-frame`（上一段尾帧抽帧）|

抽尾帧命令：

```bash
ffmpeg -y -sseof -0.1 -i seg_prev.mp4 -frames:v 1 -q:v 2 /tmp/seg_next_firstframe.png
```

---

## 3. 三种用法

### 3.1 用法 1 — h3.c + turbo 模型（⭐ 推荐，最快上手）

#### 跑法

```bash
# 预检内存（>= 30% free 才稳）
free=$(memory_pressure | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%')
[ "${free:-0}" -lt 30 ] && { echo "ABORT"; exit 1; }

# 必须在 h3.c 目录跑（cwd 路径解析）
cd /Users/jiangzhenguo/ai/h3/h3.c

# nohup 脱钩（避免 300s bash-tool watchdog 杀进程）
LOG=/tmp/run.log
OUT=/path/to/output.mp4
FIRST=/path/to/ref.jpg

nohup ./h3 \
  -d /Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo-T8test \
  --width 576 --height 1024 \
  --frames 124 --steps 8 --layers 50 --reuse 1 \
  --first-frame "$FIRST" \
  --prompt "$(cat /tmp/prompt.txt)" \
  -o "$OUT" > "$LOG" 2>&1 &
PID=$!
disown
echo "$PID" > /tmp/run.pid
```

#### 参数选型（M5 Pro 64GB 实测）

| 分辨率 | 步数 | 步数模型 | 估时（关 ssd） | 内存峰值 |
|---|---|---|---|---|
| 448×768 | 8 | turbo-T8test | ~14-18 min | ~10 GB |
| 480×864 | 8 | turbo-T8test | ~17-20 min | ~11 GB |
| **576×1024** | **8** | turbo-T8test | **~10-12 min** | ~12 GB ⭐ 甜点档 |
| 544×960 | 8 | turbo-T8test | ~10-12 min | ~10 GB（最接近 540p）|
| 704×1280 | 8 | turbo-T8test | ~25-28 min | ~15 GB |
| 704×1280 | 20 | 原版 | ~67 min | ~18 GB |

**推荐**：**576×1024 + 8 步**（甜点档，省时间 + 质量稳）

#### 关 vs 开 ssd-streaming（重要）

| 配置 | 墙钟 | RSS |
|---|---|---|
| **关 `--ssd-streaming`** | **29 min**（实测） | ~10 GB |
| 开 `--ssd-streaming` | 43 min | ~6 GB |

**Apple Silicon 64GB 跑 576×1024 默认关 ssd-streaming**，比开快 ~30%。`--ssd-streaming` 是 RAM 紧张时的 escape hatch，64GB+ 反而拖慢。

> 应用侧：设置页「通用 → SSD 流式读权重（--ssd-streaming）」全局开关，**默认关**；开启后所有 h3 视频任务提交时自动追加 `--ssd-streaming`。

只有以下情况才开：
- 空闲 < 20%
- 跑大规格（704×1280 / 768×1536）
- 同时挂多张 ref-image

### 3.2 用法 2 — ComfyUI + base + LoRA

需要 ComfyUI 安装。适合做 UI 工作流调试。

#### 安装

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git /Users/jiangzhenguo/ai/ComfyUI
cd /Users/jiangzhenguo/ai/ComfyUI
python3.10 -m venv .venv
.venv/bin/pip install -U pip torch torchvision
.venv/bin/pip install -r requirements.txt

# 软链模型（让 ComfyUI 能找到）
mkdir -p models/checkpoints models/loras
ln -sf /Users/jiangzhenguo/ai/h3/MiniMax-H3 models/checkpoints/MiniMax-H3
ln -sf /Users/jiangzhenguo/ai/h3/turbo-lora/minimax_h3_turbo_v4_step600_ema.safetensors \
       models/loras/minimax_h3_turbo_v4.safetensors
```

#### 工作流节点

```
Load Checkpoint → MiniMax-H3
        ↓
Load LoRA       → minimax_h3_turbo_v4.safetensors  (strength_model=1.0, strength_clip=1.0)
        ↓
CLIP Text Encode (positive) → 你的 prompt
        ↓
KSampler       → steps=4, cfg=1.0, sampler=euler, scheduler=sgm_uniform
        ↓
VAE Decode + Save MP4
```

### 3.3 用法 3 — Diffusers Python + base + LoRA

#### 安装

需要 MiniMax-H3 的 diffusers fork（官方 diffusers 不支持）。最简方案：等官方加，或自己写 loader。

```bash
# 用法 3 的 venv（Python 3.10）
python3.10 -m venv /Users/jiangzhenguo/venvs/diffusers
/Users/jiangzhenguo/venvs/diffusers/bin/pip install -U pip
/Users/jiangzhenguo/venvs/diffusers/bin/pip install torch torchvision diffusers transformers accelerate
# + 装支持 MiniMax-H3 的 diffusers fork（参考 TencentARC/HunyuanVideo / 类似 fork）
```

#### 跑法

```python
import torch
from diffusers import HunyuanVideoPipeline  # 占位，用 MiniMax-H3 对应类

pipe = HunyuanVideoPipeline.from_pretrained(
    "/Users/jiangzhenguo/ai/h3/MiniMax-H3",
    torch_dtype=torch.bfloat16,
)
pipe.load_lora_weights(
    "/Users/jiangzhenguo/ai/h3/t8star-lora",
    weight_name="minimax_h3_turbo_4step_ema_comfyui_stripped.safetensors",
)
pipe.fuse_lora()
pipe.enable_model_cpu_offload()  # 64GB 可能不需要，看 OOM 决定

out = pipe(
    prompt="...",
    num_frames=124,
    height=1024,
    width=576,
    num_inference_steps=4,
    guidance_scale=1.0,
).frames[0]
```

`strip_prefix.py` 转换 ComfyUI key 命名为 Diffusers key 命名：

```bash
python3 ~/ai/h3/t8star-lora/strip_prefix.py \
  ~/ai/h3/t8star-lora/minimax_h3_turbo_4step_ema_comfyui.safetensors \
  ~/ai/h3/t8star-lora/minimax_h3_turbo_4step_ema_comfyui_stripped.safetensors
```

> ⚠️ MiniMax-H3 在官方 diffusers 里没现成 pipeline 类，要用 fork 或自己写 loader。如果用户已经有 ComfyUI 体验，建议直接走用法 2。

---

## 4. 后处理（每次出片必做）

### 4.1 2x 超分

```bash
# realesrgan wrapper 已装好在 PATH
realesrgan input.mp4 -s 2 -n realesr-animevideov3 -o out_2x.mp4
# 默认模型 realesr-animevideov3（视频 + 通吃，h3.c 风格最佳）
# 可选模型：realesrgan-x4plus（通用）、realesrgan-x4plus-anime（动漫插画）
```

5s @ 576×1024 → 1152×2048：~2-3 min  
5s @ 704×1280 → 1408×2560：~5-7 min

### 4.2 修脸

**方案 A（推荐，CodeFormer，保真度高）**：

```bash
# 一次性软链
mkdir -p ~/ai/CodeFormer/weights/CodeFormer
ln -sf ~/ai/weights/codeformer.pth ~/ai/CodeFormer/weights/CodeFormer/codeformer.pth

# 流水线：拆帧 → CodeFormer → 拼回
WORK=$(mktemp -d /tmp/cf.XXXXXX)
ffmpeg -y -i out_2x.mp4 -qscale:v 1 -vsync passthrough "$WORK/frames/f_%05d.png"

~/venvs/superres/bin/python ~/ai/CodeFormer/inference_codeformer.py \
  -i "$WORK/frames" \
  -o "$WORK/cf" \
  -w 0.7 -s 1 \
  --bg_upsampler None \
  --suffix cf

FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 out_2x.mp4 | head -1)
ffmpeg -y -framerate "$FPS" -i "$WORK/cf/final_results/f_%05d_cf.png" \
  -i out_2x.mp4 -map 0:v:0 -map 1:a:0? \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow \
  -c:a copy -movflags +faststart out_cf2x.mp4
```

**fidelity_weight (-w) 选型**：

| 值 | 效果 | 适合 |
|---|---|---|
| 0.0 | 极限质量（容易变脸）| 失真严重 |
| 0.5 | CodeFormer 默认 | 中性 |
| **0.7** | **保真优先，去瑕不毁脸** | **角色/真人（推荐）** |
| 0.9 | 偏保真 | 轻微增强 |

**方案 B（GFPGAN v1.4，修脸狠）**：

```bash
~/venvs/superres/bin/python ~/ai/GFPGAN/inference_gfpgan.py \
  -i "$WORK/frames" \
  -o "$WORK/gfpgan" \
  -v 1.4 -s 1 -w 0.5 \
  --bg_upsampler none \
  --suffix fix
```

⚠️ 注意 `--bg_upsampler None`（不是 realesrgan）。Apple Silicon 没 CUDA + 没装 Python `realesrgan` 包，否则会报错。

**输出路径关键事实**：

| 工具 | 输出目录 | 文件名格式 |
|---|---|---|
| GFPGAN | `restored_imgs/` | `f_%05d_fix.png` |
| CodeFormer | `final_results/` | `f_%05d_cf.png` |

### 4.3 整合脚本（一行）

```bash
# /Users/jiangzhenguo/bin/fixface2x （如果要保存）
# 输入 mp4 → 输出 fixface+2x mp4
realesrgan "$1" -s 2 -n realesr-animevideov3 -o "${1%.mp4}-2x.mp4"
WORK=$(mktemp -d /tmp/cf.XXXXXX)
ffmpeg -y -i "${1%.mp4}-2x.mp4" -qscale:v 1 -vsync passthrough "$WORK/f_%05d.png"
~/venvs/superres/bin/python ~/ai/CodeFormer/inference_codeformer.py \
  -i "$WORK" -o "$WORK/out" -w 0.7 -s 1 --bg_upsampler None --suffix cf
FPS=$(ffprobe ... | head -1)
ffmpeg -y -framerate "$FPS" -i "$WORK/out/final_results/f_%05d_cf.png" \
  -i "${1%.mp4}-2x.mp4" -map 0:v:0 -map 1:a:0? \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow \
  -c:a copy "${1%.mp4}_cf2x.mp4"
```

---

## 5. 已知坑（必读，踩过至少一次）

### 5.1 32 倍数分辨率限制

h3.c 强制 width × height 都是 32 倍数。**报错**：

```
width and height must be multiples of 32 and at least 32
```

| 用户想跑的 | 合法替代 |
|---|---|
| 540p (540×960) | **544×960**（宽 +4px） |
| 720p (720×1280) | **704×1280**（宽 -16px） |
| 1080p (1080×1920) | **1088×1920**（宽 +8px） |

合法 9:16 档：480×864 / 512×896 / **576×1024 ⭐** / 704×1280 / 768×1536

### 5.2 内存预检

```bash
free=$(memory_pressure | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%')
[ "${free:-0}" -lt 30 ] && abort
```

跑片前必跑。`denoise enqueue` 卡 60s+ = OOM 死。

### 5.3 cwd 路径

h3.c 走相对路径找 `h3_shaders.metal`。**必须 cd 进 h3.c 目录**：

```bash
cd /Users/jiangzhenguo/ai/h3/h3.c
# 或
pushd /Users/jiangzhenguo/ai/h3/h3.c >/dev/null && ... && popd >/dev/null
```

报错 `cannot compile h3_shaders.metal` = cwd 不对。

### 5.4 nohup + disown 脱钩

`bash` tool 有 **300s 硬超时**。h3.c 单段 12-30 min，必须 nohup + disown：

```bash
nohup ./h3 ... > "$LOG" 2>&1 &
PID=$!
disown
echo "$PID" > /tmp/run.pid   # 留 PID 给后续轮询
```

### 5.5 first-frame 抽帧

段间衔接：

```bash
ffmpeg -y -sseof -0.1 -i prev_seg.mp4 -frames:v 1 -q:v 2 next_seg_firstframe.png
```

`-sseof -0.1` 取最后 0.1s 的关键帧。

### 5.6 长视频分段拼接

> 5s 单跑 ≈ 12-30 min / 段。**单次 60s 不现实**（撞内存+时间双墙）。

多段拼接策略：
- 5s × N 段：每段 124 帧 / 12-18 min，最长单段稳定
- 10s × N 段：每段 243 帧 / ~30 min
- 60s 推荐：6 × 10s（180 min）或 12 × 5s（192 min），时间几乎一样

段间过渡必须 first-frame 锁上一段尾帧，否则 prompt 跨度大模型自由发挥飘走。

### 5.7 first-frame 与 ref-image 互斥

```
full references cannot be combined with frame anchors
```

二选一：
- 用 ref-image：每段都加 ref-image（锁脸）
- 用 first-frame：seg1 用 ref-image，seg2+ 改 first-frame（保动作连续）

### 5.8 CodeFormer 首次跑要下权重

第一次跑会下 ~80MB dlib 辅助权重到 `~/.cache/torch/hub/` 或 `CodeFormer/weights/`，缓存后不重下。约 +80s 启动时间。

### 5.9 KEEP 是另一个视频人脸超分

> ECCV 2024 "Kalman-Inspired Feature Propagation for Video Face Super-Resolution"
> 仓库：https://github.com/jnjaby/KEEP
> 关键优势：跨帧传 Kalman 状态，**帧间一致性优于 CodeFormer**
> 缺点：官方要 CUDA，Apple Silicon MPS 没测过

5s 单段 CodeFormer 够用（看不出 flicker）。多段拼接（≥30s）再考虑 KEEP。

---

## 6. 端到端示例（从 prompt 到 final_cf2x.mp4）

### 6.1 单段 5s

```bash
# Step 1: 写 prompt（5 段式）
cat > /tmp/prompt.txt <<'EOF'
【Shot】 Vertical 9:16 medium-full shot, slightly low-angle, ... cinematic 24fps, smooth continuous take.
【Subject】 Same 22-year-old East-Asian girl from reference: ...
【Environment】 Same indoor room: beige walls, polished wood floor, soft daylight from side window.
【Action】 Four-beat phrase, 5 seconds:
(0.0-1.0s) ...
(1.0-2.0s) ...
(2.0-3.0s) ...
(3.0-4.0s) ...
(4.0-5.0s) ...
【Audio】 Crisp fabric rustle, soft pop, light thud, small laugh. Non-diegetic: celesta melody.
EOF

# Step 2: 跑片
cd /Users/jiangzhenguo/ai/h3/h3.c
nohup ./h3 \
  -d /Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo-T8test \
  --width 576 --height 1024 \
  --frames 124 --steps 8 --layers 50 --reuse 1 \
  --first-frame /path/to/ref.jpg \
  --prompt "$(cat /tmp/prompt.txt)" \
  -o /tmp/out.mp4 > /tmp/out.log 2>&1 &
disown

# Step 3: 监控
PID=$!
while kill -0 $PID 2>/dev/null; do
  sleep 30
  tail -c 400 /tmp/out.log | tr '\r' '\n' | tail -1
done

# Step 4: 超分
realesrgan /tmp/out.mp4 -s 2 -n realesr-animevideov3 -o /tmp/out_2x.mp4

# Step 5: 修脸
WORK=$(mktemp -d /tmp/cf.XXXXXX)
ffmpeg -y -i /tmp/out_2x.mp4 -qscale:v 1 -vsync passthrough "$WORK/f_%05d.png"
~/venvs/superres/bin/python ~/ai/CodeFormer/inference_codeformer.py \
  -i "$WORK" -o "$WORK/out" -w 0.7 -s 1 --bg_upsampler None --suffix cf
ffmpeg -y -framerate 24 -i "$WORK/out/final_results/f_%05d_cf.png" \
  -i /tmp/out_2x.mp4 -map 0:v:0 -map 1:a:0? \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow \
  -c:a copy /tmp/out_cf2x.mp4
```

### 6.2 多段拼接（5s × 3）

```bash
# Seg 1: 用 ref-image 锁脸
cd /Users/jiangzhenguo/ai/h3/h3.c
nohup ./h3 -d .../MiniMax-H3-turbo-T8test \
  --width 576 --height 1024 \
  --frames 124 --steps 8 --layers 50 --reuse 1 \
  --ref-image ref1.jpg --ref-image ref2.jpg \
  --prompt 'seg1 prompt' \
  -o seg1.mp4 & disown
wait

# 抽 seg1 尾帧
ffmpeg -y -sseof -0.1 -i seg1.mp4 -frames:v 1 -q:v 2 seg2_first.png

# Seg 2: 用 first-frame 接续
nohup ./h3 -d .../MiniMax-H3-turbo-T8test \
  --width 576 --height 1024 \
  --frames 124 --steps 8 --layers 50 --reuse 1 \
  --first-frame seg2_first.png \
  --prompt 'seg2 prompt' \
  -o seg2.mp4 & disown
wait

# Seg 3: 同上
... (抽 seg2 尾帧 + 跑 seg3)

# 拼回
echo "file 'seg1.mp4'" > list.txt
echo "file 'seg2.mp4'" >> list.txt
echo "file 'seg3.mp4'" >> list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c copy final.mp4
```

### 6.3 内存参考（M5 Pro 64GB 实测）

| 任务 | RSS 峰 | 空闲从 87% → |
|---|---|---|
| h3.c 576×1024 8 步 关 ssd | ~12 GB | 87% → 60% |
| h3.c 704×1280 8 步 关 ssd | ~15 GB | 87% → 43% |
| h3.c 576×1024 20 步 开 ssd | ~6 GB | 87% → 70% |
| 超分 576×1024 → 1152×2048 | ~4 GB | -5% |
| CodeFormer 124 帧 | ~10 GB | -15% |

关闭 Chrome / WeChat / DingTalk 等大应用能多留 5-10 GB。

---

## 7. 故障排查速查表

| 现象 | 原因 | 修法 |
|---|---|---|
| `cannot compile h3_shaders.metal` | cwd 不对 | `cd /Users/jiangzhenguo/ai/h3/h3.c` |
| `width and height must be multiples of 32` | 分辨率不合法 | 选 32 倍数（576/704/704/768） |
| `full references cannot be combined with frame anchors` | 同时用了 | 二选一 |
| `denoise enqueue 0/N` 卡 60s+ | OOM | `memory_pressure` 查空闲，关其他 app |
| `mp4 < 30KB` / 没产出 | OOM / 模型加载失败 / pushd 不对 | tail log 看具体报错 |
| 超分后画面有 grid / checkerboard | 视频降采样不够 / 模型选错 | 换 `realesr-animevideov3`（默认） |
| CodeFormer 输出空 | "no face detected" | 跳过修脸直接用 `-2x.mp4` |
| GFPGAN 输出变形 | `-w 0.5` 太激进 | 降到 `-w 0.3` 或换 CodeFormer |
| `bg_upsampler realesrgan` 报错 | Apple Silicon 没 CUDA | 必加 `--bg_upsampler None` |

---

## 8. BigBotArt 应用集成（本机）

> 本机 BigBotArt workspace 已把「加速 LoRA」作为一等公民接入：
> 设置页管理**蒸馏模型包**（turbo 模型目录 + 推荐步数），视频镜头节点用「加速 LoRA」开关一键切换；
> **接入的是本手册 §3.1 用法（蒸馏模型目录 + 少步数），不是挂载 `.safetensors`**（见 §8.4 澄清）。

### 8.1 功能入口

| 入口 | 位置 | 作用 |
|---|---|---|
| 加速 LoRA 管理 | 设置页 → 侧栏「加速 LoRA」分组 | 安装 / 管理蒸馏模型包（目录 + 推荐步数），设默认 |
| 镜头加速开关 | 画布 → 镜头节点检查器「加速 LoRA」小节 | 该镜头出片时切到蒸馏模型包 + 4/8 步 |

### 8.2 镜头节点「加速 LoRA」行为

开启后，该镜头提交到 h3.c 的命令与默认路径的差异：

| 参数 | 默认（不开） | 开启加速 |
|---|---|---|
| `-d` 模型目录 | `MiniMax-H3`（base，20 步档） | 所选包目录（默认 `MiniMax-H3-turbo-T8test`） |
| `--steps` | 档位预设（6/12/20/30） | 加速档 **4 或 8**（默认 8） |
| `--layers` / `--reuse` / `--frames` / 宽高 | 档位预设 | 保持不变（档位预设） |
| 预计耗时 | 档位 ETA | ≈ ×0.2（4 步）/ ×0.35（8 步） |

- 加速步数只在**提交时**覆盖 `steps`；节点上手动改的 F/S/L/R 仍保留，关掉加速即恢复原档位。
- 接续链的「画面规格继承」（比例 + 档位三件套）**不含**加速字段：每个镜头自己决定加不加速。
- 检查器中开启加速后，建议给该镜头标「⚡ 加速」提示（4 步边缘细节略糊，8 步为质量甜点）。

### 8.3 设置页管理（蒸馏模型包）

- **模型包** = 一个可传给 `h3 -d` 的模型目录（含 `FL2VA/`，如 `MiniMax-H3-turbo-T8test`），**不是** `.safetensors` 文件。
- **安装**：填名称 + 目录路径 + 推荐步数（4/8）；主进程校验目录存在且含 `FL2VA/` 后登记。
- **管理**：列表显示「就绪 / 目录缺失」状态与推荐步数；可**设默认**（镜头开启加速但未选包时用默认包）、可**删除**（只注销登记，不删磁盘文件）。
- **预置**：默认登记两条知名目录 `MiniMax-H3-turbo-T8test`（推荐，默认项）与 `MiniMax-H3-turbo`；本机不存在时列表标「目录缺失」。
- **数据落点**：`~/.bigbotart/settings.json` 的 `accelPacks` 数组（`{ id, name, path, steps, default, installedAt }`）。

### 8.4 与 `.safetensors` LoRA 的关系（澄清）

- BigBotArt 的 h3.c 路径**不挂载 LoRA 文件**；应用不会生成/使用 `.safetensors`，`~/.bigbotart/loras/` 不存在。
- 需要 ComfyUI / Diffusers 挂载 LoRA（本手册 §3.2 / §3.3）时，仍按第 3 章手动操作；app 内的「加速 LoRA」只对应 §3.1 蒸馏模型包用法。

---

## 9. 参考链接

- h3.c GitHub: https://github.com/antirez/h3.c
- CodeFormer GitHub: https://github.com/sczhou/CodeFormer
- GFPGAN GitHub: https://github.com/TencentARC/GFPGAN
- Real-ESRGAN ncnn-vulkan: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
- KEEP GitHub: https://github.com/jnjaby/KEEP（视频人脸超分，CUDA only）

---

**编写日期**：2026-09-19
**BigBotArt 集成说明**：2026-09-19（v0.1，对应 §8）
**适用版本**：h3.c 2026-09-17 / CodeFormer 1.0 / GFPGAN 1.4 / Real-ESRGAN animevideov3 / BigBotArt workspace
**实测环境**：M5 Pro 64GB Apple Silicon Mac / macOS