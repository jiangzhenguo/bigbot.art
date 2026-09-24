#!/usr/bin/env python3
"""
重建 proj-1789363510085-tp83c 的主画布节点(2026-09-22 画布文件被写成空画布后的数据抢救)。

数据来源:~/.bigbotart/takes-proj-1789363510085-tp83c.json
  Take 里完整保留了每个节点的生成参数(prompt/model/width/height/…)与产物路径,
  据此还原节点的 kind、标题、data(生成参数 + resultPath),并按创建时间网格排布。

用法:
  python3 scripts/rescue-canvas-tp83c.py --dry-run   # 只打印预览
  python3 scripts/rescue-canvas-tp83c.py             # 原子写回(先备份现有文件)
"""
import argparse
import collections
import json
import os
import shutil
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("BIGBOTART_HOME", Path.home() / ".bigbotart"))
PROJECT_ID = "proj-1789363510085-tp83c"
CANVAS_ID = "cv-1789363510086-hp5l"
TAKES = HOME / f"takes-{PROJECT_ID}.json"
TARGET = HOME / f"canvases-{PROJECT_ID}.json"

# 网格排布(与 CanvasPage 的节点尺度一致:普通节点 224 宽,storyboard 318)
COL_W, ROW_H, PAD = 300, 300, 40
COLS = 4

# 节点 id 前缀 → 展示用标题后缀 + 节点类型
def classify(node_id: str, kind: str | None) -> tuple[str, str]:
    """返回 (展示标题, 渲染层节点 kind)"""
    if kind == "video":
        return ("镜头", "shot")
    if kind == "generate":
        return ("图片生成", "image-gen")
    if kind == "instruction":
        return ("图片编辑", "image-edit")
    if kind in ("upscale", "crop"):
        return ("图片增强" if kind == "upscale" else "图片裁切", "image-upscale" if kind == "upscale" else "image-crop")
    # 无 params(更早期的 mock 任务):按 id 前缀兜底
    if node_id.startswith("new2"):
        return ("图片生成", "image-gen")
    return ("节点", "shot")


def build_nodes() -> list[dict]:
    takes = json.loads(TAKES.read_text(encoding="utf-8")).get("takes", [])
    by = collections.defaultdict(list)
    for t in takes:
        by[t["shotNodeId"]].append(t)

    # 按首次出现时间排序(与原画布上的创建顺序一致 → 网格顺序可读)
    order = sorted(by.items(), key=lambda kv: min(z["createdAt"] for z in kv[1]))

    # 同类型计数,用于「镜头 01 / 图片生成 02」这类标题
    counters: dict[str, int] = collections.Counter()
    nodes: list[dict] = []
    for idx, (node_id, group) in enumerate(order):
        last = max(group, key=lambda z: z["createdAt"])
        params = last.get("params") or {}
        label_base, node_kind = classify(node_id, params.get("kind"))
        counters[label_base] += 1
        title = f"{label_base} {counters[label_base]:02d}"

        # data:生成参数(渲染/重跑用)+ 最新产物路径(节点卡显示视频/图片)
        data: dict = {}
        for key in ("model", "prompt", "width", "height", "steps", "guidance", "seeds",
                    "seconds", "frames", "layers", "reuse", "tier", "seed", "mode",
                    "negativePrompt", "scale", "imageStrength", "outpaintSides"):
            if params.get(key) is not None:
                data[key] = params[key]
        # 引擎:视频类走 h3c,图片类走 mlxgen(与原画布一致)
        data["engine"] = "h3c" if node_kind == "shot" else "mlxgen"
        if last.get("resultPath"):
            data["resultPath"] = last["resultPath"]
            data["currentTakeId"] = last["id"]
        if params.get("kind"):
            data["kind"] = params["kind"]

        nodes.append({
            "id": node_id,
            "kind": node_kind,
            "label": title,
            "position": {
                "x": PAD + (idx % COLS) * COL_W,
                "y": PAD + (idx // COLS) * ROW_H,
            },
            "width": 224,
            "data": data,
        })
    return nodes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not TAKES.exists():
        print(f"找不到 Take 文件:{TAKES}", file=sys.stderr)
        return 1
    nodes = build_nodes()
    print(f"从 Take 历史还原 {len(nodes)} 个节点:")
    for n in nodes:
        has = "有产物" if n["data"].get("resultPath") else "无产物"
        print(f"  {n['id']:26s} {n['kind']:12s} {n['label']:12s} {has}  {str(n['data'].get('prompt'))[:40]!r}")

    if args.dry_run:
        print("\n(dry-run,未写盘)")
        return 0

    pc = json.loads(TARGET.read_text(encoding="utf-8"))
    canvas = next(c for c in pc["canvases"] if c["id"] == CANVAS_ID)
    if canvas.get("nodes"):
        print(f"⚠️ 目标画布已有 {len(canvas['nodes'])} 个节点,拒绝覆盖(先手动确认)", file=sys.stderr)
        return 2
    bak = TARGET.with_suffix(f".json.pre-rescue-{int(time.time() * 1000)}")
    shutil.copy2(TARGET, bak)
    canvas["nodes"] = nodes
    canvas["edges"] = []
    canvas["version"] = int(canvas.get("version") or 0) + 1
    canvas["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    tmp = TARGET.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(pc, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, TARGET)  # 原子替换,避免半截文件
    print(f"\n✅ 已写回 {TARGET}(备份:{bak.name},version → {canvas['version']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
