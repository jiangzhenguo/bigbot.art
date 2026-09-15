# h3.c 使用文档（接口集成版）

> MiniMax-H3 本地推理 — antirez/h3.c (h3-metal) · Apple Silicon only
> 适用版本：h3.c 当前 main 分支（2026-09）

---

## 1. 概览

`h3` 是 antirez 用纯 C + Metal 实现的 MiniMax-H3 视频/音频生成推理引擎，仅支持 macOS Apple Silicon（M1+）。
本地无网络依赖，单二进制 + Metal GPU 加速。

| 能力 | 支持 |
|---|---|
| 文字 → 视频/音频 (T2VA) | ✅ |
| 文字 + 首/末帧锚定 (FL2VA) | ✅ |
| 文字 + 1-9 张参考图/视频/音频 (Ref2VA) | ✅（多张按顺序追加） |
| 仅视频 / 仅图像 / 仅音频 | ✅ |
| 交互模式（terminal 连续跑） | ✅ |
| 非 Apple Silicon / NVIDIA GPU / 远程推理 | ❌ |

输出：单文件 MP4 (h264 + aac, 24 fps)。

---

## 2. 环境与依赖

### 系统要求

| 项 | 要求 |
|---|---|
| OS | macOS 13+ (Apple Silicon) |
| GPU | Apple M1 / M2 / M3 / M4 / M5（任意）|
| 内存 | ≥ 32 GB 推荐（5s 段峰值 RAM ~25 GB；full HD 段 ~50 GB）|
| 磁盘（SSD）| 完整模型 ~270 GB（`Ref2VA` + `FL2VA` 各 134 GB）|
| ffmpeg / ffprobe | PATH 中可用（视频/音频编码）|

### 本地路径约定

| 资源 | 绝对路径 |
|---|---|
| 二进制 | `/Users/jiangzhenguo/ai/h3/h3.c/h3` |
| Metal shader（依赖 cwd）| `/Users/jiangzhenguo/ai/h3/h3.c/h3_shaders.metal` |
| 模型根目录 | `/Users/jiangzhenguo/ai/h3/MiniMax-H3/` |
| T2VA 模型子目录 | `/Users/jiangzhenguo/ai/h3/MiniMax-H3/FL2VA/` |
| Ref2VA 模型子目录 | `/Users/jiangzhenguo/ai/h3/MiniMax-H3/Ref2VA/` |

⚠️ 二进制路径与 shader 必须在**同一目录**；Metal shader 解析依赖相对路径或 `argv[0]` dirname。**启动前必须 `cd /Users/jiangzhenguo/ai/h3/h3.c`**。

---

## 3. 快速开始（最小命令）

```bash
# 5s 段、544²、20 步、3 张参考图、保留音轨
cd /Users/jiangzhenguo/ai/h3/h3.c
./h3 \
  -d /Users/jiangzhenguo/ai/h3/MiniMax-H3/Ref2VA \
  --width 544 --height 544 \
  --frames 124 \
  --steps 20 \
  --layers 50 \
  --reuse 1 \
  -p "A young Asian woman ... [prompt]" \
  --ref-image /path/to/face.png \
  --ref-image /path/to/scene.png \
  --ref-image /path/to/action.png \
  --seed 42 \
  -o /path/to/output.mp4
```

输出文件包含视频 + 音轨 + 文字描述嵌入。**任何参数不匹配约束都会立即报错退出**（启动期），不会写到一半。

---

## 4. CLI 参数详解

### 4.1 必需

| 参数 | 说明 |
|---|---|
| `-d, --model-dir PATH` | 模型子目录（`Ref2VA` 或 `FL2VA`），必填 |
| `-p, --prompt TEXT` | H3 prompt（无 `-p` 启动交互模式）|
| `-o, --output PATH` | 输出 mp4，默认 `outputs/h3.mp4` |

### 4.2 输出控制

| 参数 | 默认 | 说明 |
|---|---|---|
| `--width N` | 864 | 输出宽度，**必须是 32 倍数** |
| `--height N` | 480 | 输出高度，**必须是 32 倍数** |
| `--frames N` | 56 | 帧数 |
| `--seconds N` | — | 替代 `--frames`：24 fps 下的秒数 |
| `--render-width N` | — | 内部模型宽度（可选，< `--width` 时降分辨率提速）|
| `--render-height N` | — | 内部模型高度（同上）|
| `--frames-dir PATH` | — | 改输出帧序列为 PPM 文件（调试用）|

合法 9:16 比例档（严格 9:16）：
- `480 × 864`
- `576 × 1024`
- `704 × 1280`
- `768 × 1536`（2K）

16:9 常用档：`864 × 480`、`1280 × 704`、`1536 × 768`。
1:1 常用档：`544 × 544`、`768 × 768`、`1024 × 1024`。

⚠️ `720 × 1280` 不合法（720 不是 32 倍数），**实际想要 720p 用 `704 × 1280`（少 16px 宽，肉眼无差）**。

### 4.3 质量与速度

| 参数 | 默认 | 推荐档 | 说明 |
|---|---|---|---|
| `--steps N` | 20 | 20（5s 段）/ 30（high quality）| 去噪步数 |
| `--reuse N` | 1 | 1 close / 2 fast / 3 aggressive | 去噪复用（越大越快，质量越低）|
| `--layers N` | 50 | 50 exact / 45 fast / 40 aggressive | DiT blocks（必须 50 保持质量）|
| `--core-reuse N` | 1 | 1 exact / 4 fast / 6 aggressive | Core 刷新间隔 |
| `--token-reduction` | off | — | 中段 DiT 视频 token 配对加速 |
| `--ssd-streaming` | off | 高分必开 | 流式读 BF16 DiT 层（节省 RAM）|

**档位组合**：
- **5s 段（推荐，~14-18 min）**：`--steps 20 --reuse 1 --layers 50`
- **快速出片（~7-10 min）**：`--steps 12 --reuse 2 --layers 50`
- **high quality（~30-50 min）**：`--steps 30 --reuse 1 --layers 50`
- **极速草稿（~3-5 min）**：`--steps 6 --reuse 3 --layers 40`

### 4.4 内存与精度

`--ssd-streaming`、`--use-int8-row-fc2`、各种 `--use-slower-*` 开关控制 Metal kernel 精度与内存布局。**默认参数在 M5 Pro 64GB 上稳跑**。

OOM 时优先开 `--ssd-streaming`（最有效的内存降档），再调 `--render-width/height` 减小内部模型分辨率。

### 4.5 条件输入

| 参数 | 说明 |
|---|---|
| `--seed N` | 默认 42。**可复现**：同 prompt + 同 seed 输出帧级一致 |
| `--first-frame PATH` | FL2VA 首帧锚定（图像）|
| `--last-frame PATH` | FL2VA 末帧锚定（图像）|
| `--ref-image PATH` | Ref2VA 参考图（**可重复 1-9 次，按顺序追加**）|
| `--ref-image-size S` | `match`（默认）或 `max`（按参考图分辨率）|
| `--ref-video PATH` | Ref2VA 参考视频（含音轨）|
| `--ref-silent-video PATH` | Ref2VA 参考视频（不带音轨）|
| `--ref-video-audio VIDEO AUDIO` | Ref2VA 视频 + 独立音轨 |
| `--ref-audio PATH` | Ref2VA 独立音频参考 |

**重要约束**：`--ref-image` 和 `--first-frame` **不能同时用**（启动报 `full references cannot be combined with frame anchors`）。二选一：

- A. **锁脸链**：每段 `--ref-image 1+ 张`，段间不连接，prompt 自己接续
- B. **动作连续链**：段 1 用 `--ref-image`，段 2+ 用 `--first-frame`（上一段尾帧）

### 4.6 调试与交互

| 参数 | 说明 |
|---|---|
| `--info` | 仅检查模型布局 + Metal device，**不映射权重，不生成视频** |
| `--show` | 每步去噪后显示一帧（M5）|
| `--zoom N` | terminal 图像缩放（Retina 默认 2）|
| `--profile` | 打印每阶段 Metal 计时 + 内存分配 |
| `-h, --help` | 完整 CLI 参考 |

无 `-p` 启动进入**交互模式**（Iris-style），可用命令：`!status`、`!seed random`、`!seconds 2`、`!show`、`!save output.mp4`、`!cache`、`!help`。

---

## 5. 输出与进度

### 5.1 输出文件

- 单文件 mp4，h264 + aac
- 24 fps
- `124 帧 ≈ 5.17 秒`（5s 段典型）
- 文件名由 `-o` 指定，相对路径依赖启动时 cwd

### 5.2 进度日志

stdout 是 carriage-return (`\r`) 覆盖式进度条，不适合做监控。**把 stdout 重定向到 log 文件**（无 PID 文件也好追踪）：

```
load transformer core       50/50    ← 加载 50 个 transformer block
denoise enqueue              N/30    ← 去噪进度
video VAE load              36/36    ← 解码 36 步
audio VAE                    7/7     ← 音频编码
FFmpeg                     124/124   ← h264 + aac 编码
h3: wrote /path/to/output.mp4         ← 写盘完成
```

判断进度的最快方式（解析 `\r` 为 `\n`）：
```bash
tail -c 3000 /path/to/log | tr '\r' '\n' | tail -10
```

### 5.3 进程状态判断

- **loading 阶段**（前 30 秒）：CPU 跑 Metal kernel 编译 + 模型加载
- **denoise 阶段**：CPU ~0%（等 GPU），Metal 占用高
- **VAE/ffmpeg 阶段**：CPU ~80%（音频 + h264 编码）
- **完成**：进程退出，exit 0

---

## 6. 工作流模板（生产用）

### 6.1 单次跑片（后台跑，防 300s watchdog）

```bash
INPUT_PROMPT="..."
OUT_PATH="/path/to/output.mp4"
LOG="/tmp/h3_$(date +%s).log"
PID_FILE="/tmp/h3_$(date +%s).pid"

# 注意: 必须 cd 到 h3.c 目录（shader cwd 依赖）
pushd /Users/jiangzhenguo/ai/h3/h3.c > /dev/null

nohup /Users/jiangzhenguo/ai/h3/h3.c/h3 \
  -d /Users/jiangzhenguo/ai/h3/MiniMax-H3/Ref2VA \
  --width 544 --height 544 \
  --frames 124 --steps 20 --layers 50 --reuse 1 \
  --seed 42 \
  -p "$INPUT_PROMPT" \
  --ref-image /path/to/ref1.png \
  -o "$OUT_PATH" \
  > "$LOG" 2>&1 &

H3_PID=$!
disown
echo "$H3_PID" > "$PID_FILE"
popd > /dev/null

echo "PID=$H3_PID log=$LOG out=$OUT_PATH"
```

### 6.2 监控 + ETA

```bash
PID=$(cat /tmp/h3_xxx.pid)
while ps -p $PID > /dev/null 2>&1; do
  ps -p $PID -o pid,etime,stat,%cpu 2>/dev/null | tail -1
  memory_pressure | grep "System-wide memory free percentage"
  tail -c 600 /tmp/h3_xxx.log | tr '\r' '\n' | tail -5
  ls -la /path/to/output.mp4 2>/dev/null || echo "未生成"
  sleep 30
done
echo "完成"
```

### 6.3 多段拼接（> 5s 长视频）

h3.c 单次超过 5s 不稳定，**必须分段拼接**：

```bash
for SEG in seg1 seg2 seg3 ... segN; do
  pushd /Users/jiangzhenguo/ai/h3/h3.c > /dev/null
  nohup ./h3 ... \
    --ref-image ref_face.png \         # 锁脸（每段）
    --first-frame /tmp/${PREV}_last.png \  # 上一段尾帧（段 2+）
    -o ${SEG}.mp4 > /tmp/${SEG}.log 2>&1 &
  wait $!
  popd > /dev/null

  # 抽尾帧做下段首帧
  ffmpeg -y -sseof -0.1 -i ${SEG}.mp4 -update 1 -q:v 2 /tmp/${SEG}_last.png
  PREV=${SEG}
done

# ffmpeg concat
echo "file 'seg1.mp4'" > list.txt
echo "file 'seg2.mp4'" >> list.txt
...
ffmpeg -f concat -safe 0 -i list.txt -c copy final.mp4
```

每段 5s 串行（不要并行，避免 OOM）。

---

## 7. 性能预估（M5 Pro 64GB 实测）

| 配置 | 加载 | 去噪 | VAE+ffmpeg | **总耗时** |
|---|---|---|---|---|
| 448 × 768 / 20 步 / 1 ref | ~30s | ~10 min | ~2 min | **14-18 min** |
| 480 × 864 / 20 步 / 1 ref | ~30s | ~20 min | ~2 min | ~22 min |
| **544 × 544 / 20 步 / 1 ref（甜点）** | ~30s | ~12 min | ~2 min | **~15 min** |
| 544 × 544 / 30 步 / 2 ref | ~30s | ~18 min | ~2 min | ~22 min |
| **576 × 1024 / 20 步 / 4 ref（甜点档）** | ~30s | ~32 min | ~2 min | **~34 min** |
| 576 × 1024 / 20 步 / 4 ref | ~30s | ~40 min | ~2 min | ~42 min |
| 704 × 1280 / 20 步 / 1 ref | ~30s | ~65 min | ~2 min | ~67 min |
| 768 × 1536 / 20 步 / 1 ref | ~30s | ~75 min | ~5 min | ~80 min |
| 864 × 480（16:9）/ 20 步 | ~30s | ~12 min | ~2 min | ~14 min |

**每 denoise step 时间**（leading indicator）：
- 448² ≈ 45 s/步
- 544² ≈ 1.0 min/步
- 576² ≈ 1.7 min/步
- 704² ≈ 3.3 min/步

**加速技巧**：
- `--reuse 3`：~30% 提速，质量降
- `--layers 40`：~30% 提速，质量降
- `--token-reduction`：~10-20% 提速
- `--ssd-streaming`：高分必开，**省 RAM 不省时间**

---

## 8. 错误处理与诊断

### 8.1 启动即死

| 错误 | 原因 | 修法 |
|---|---|---|
| `cannot compile h3_shaders.metal` | cwd 不在 h3.c 目录 | `pushd /Users/jiangzhenguo/ai/h3/h3.c` 后再跑 |
| `width and height must be multiples of 32` | 分辨率非法 | 改成 32 倍数（见 4.2 合法档）|
| `full references cannot be combined with frame anchors` | `--ref-image` 和 `--first-frame` 同时用 | 二选一 |
| `model directory not found` | `-d` 路径错 | 检查 `/Users/jiangzhenguo/ai/h3/MiniMax-H3/{Ref2VA,FL2VA}/` |
| mp4 文件 < 30KB | OOM / 加载失败 | 检查 log 末尾；关掉其他 app；加 `--ssd-streaming` |

### 8.2 跑片中途挂

| 症状 | 原因 | 修法 |
|---|---|---|
| 进程被 SIGKILL（macOS jetsam）| OOM | 加 `--ssd-streaming`，减小 `--render-width/height` |
| 跑到 1/N 步卡死 | Metal driver hang | 重启；换 `--reuse 2` |
| `denoise enqueue 0/30` 一直不变 | 模型加载失败 | tail log 看真实错误 |

### 8.3 输出文件异常

| 症状 | 原因 | 修法 |
|---|---|---|
| mp4 < 30KB | OOM / pushd 错 / 模型加载失败 | 看 log 第一行 |
| 输出画面全黑 | prompt 与 ref-image 矛盾 | 检查 prompt 是否与参考图风格一致 |
| 段间不连续 | 没用 `--first-frame` 锁 | 段 2+ 加 `--first-frame` |

### 8.4 诊断 Checklist

1. `tail $LOG` 看最后报错
2. `ps -p $PID` 看进程是否在
3. `memory_pressure | grep "System-wide memory free percentage"` 看 RAM
4. `ls -la $(dirname $H3_BIN)/h3_shaders.metal` 确认 shader 在
5. 检查 cwd（脚本必须 pushd 到 h3.c）

---

## 9. 与其他组件集成

### 9.1 超分（已有 Real-ESRGAN 工具链）

h3.c 出 544² → 用 `~/bin/realesrgan` 做 2x → 1088²：

```bash
~/bin/realesrgan /path/to/out.mp4 -s 2 -o /path/to/out-2x.mp4
```

3-4 分钟，产物 ~4 MB。

### 9.2 GFPGAN 修脸（已有工具链）

```bash
~/venvs/superres/bin/python ~/ai/face-fix/face_fix_video.py \
  /path/to/out.mp4 -o /path/to/out_fixface.mp4 -s 2 -m gfpgan
```

3-5 分钟，产物 ~1-3 MB。

### 9.3 FFmpeg 元数据

```bash
ffprobe -v error -show_format -show_streams out.mp4 \
  | grep -E "(width|height|duration|bit_rate|codec_name|r_frame_rate|nb_frames)"
```

---

## 10. 集成 API 设计建议

包装成函数调用（任意界面：CLI / Agent / Web UI / REST）：

```python
def h3_render(
    prompt: str,
    ref_images: list[Path] | None = None,
    width: int = 544,
    height: int = 544,
    frames: int = 124,           # 5s 段
    steps: int = 20,             # 5s 段甜点
    layers: int = 50,            # 满档
    reuse: int = 1,
    first_frame: Path | None = None,
    last_frame: Path | None = None,
    seed: int = 42,
    model: str = "Ref2VA",       # 或 "FL2VA"
    output: Path = Path("outputs/out.mp4"),
    background: bool = True,
) -> RenderResult:
    """跑一片 h3.c 视频。返回 PID + log path + 估算 ETA。"""
```

**关键约束（调用方必须尊重）**：
1. `width × height` 都必须是 32 倍数（合法档见 §4.2）
2. `ref_images` 和 `first_frame` 不能同时非空
3. `ref_images` 数量 1-9
4. 输出路径最终文件存在 = 跑片成功
5. 5s 段最小 ETA 14 分钟，建议超时 ≥ 30 分钟
6. 内存峰值 25GB（5s 段）/ 50GB（高分），调用前检查 `memory_pressure`

**集成接口示例（CLI 包装）**：

```bash
h3-cli render \
  --prompt "..." \
  --width 544 --height 544 \
  --steps 20 \
  --ref face.png --ref scene.png \
  --out /path/to/out.mp4 \
  --background        # 后台跑，返回 PID
```

返回：
```json
{"pid": 42129, "log": "/tmp/h3_xxx.log", "out_path": "...", "eta_seconds": 900}
```

调用方轮询 `log` 拿 step 进度，或等 PID 退出后读 `out_path`。

---

## 11. 已知坑（用户实战总结）

| 坑 | 修法 |
|---|---|
| 单次跑片 60s 不现实，会撞 RAM/时间双墙 | 走分段拼接（§6.3）|
| 长视频（>30s）必须多段 | 5s × N 段串行 |
| 输出文件名相同会被覆盖 | 跑片前用时间戳后缀 |
| `pushd`/`popd` 后 `cwd` 丢失 | h3.c 跑片时 `pushd` 必须在每段 |
| Metal shader 找不到 → 立即退出 | 启动前 pushd 到 h3.c |
| 内存吃紧时 Metal 卡死 | 关其它 app，加 `--ssd-streaming` |
| prompt 含 ref-image 时 `--first-frame` 冲突 | 二选一（§4.5）|

---

## 12. 关键路径速查

```text
二进制:        /Users/jiangzhenguo/ai/h3/h3.c/h3
Shader:        /Users/jiangzhenguo/ai/h3/h3.c/h3_shaders.metal
模型:          /Users/jiangzhenguo/ai/h3/MiniMax-H3/{Ref2VA,FL2VA}/
超分:          ~/bin/realesrgan
修脸:          ~/ai/face-fix/face_fix_video.py
参考脸(试验):   ~/ai/face-fix/face_fix_video_ref.py  (需真 inswapper onnx)
```

---

## 13. 版本与支持

- **h3.c**：`antirez/h3.c`（main 分支，2026-09 当前）
- **模型**：`/Users/jiangzhenguo/ai/h3/MiniMax-H3/`（Ref2VA 134GB + FL2VA 134GB）
- **运行平台**：macOS Apple Silicon（M1-M5）

接口集成问题：本机环境由 Mavis 维护，参考 `/Users/jiangzhenguo/.minimax/agents/mavis/memory/MEMORY.md` 中的 h3 相关条目。