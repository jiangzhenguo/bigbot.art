#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
画布数据完整恢复 — 事故:「Agent 操作的画布被渲染层旧快照覆盖」,
随后 CanvasPage 崩溃/热重载又用空快照把盘上的 3 个 image-gen 一并冲掉。

恢复依据:
- pal2/pal4/pal5(3 个 image-gen):完整 data/position 截获自事故前盘文件(22:44 读盘内容)
- shot-1790001542801-gyec:参数来自 take take-1790001601971-bjfi + 主进程日志(label/连线)
- ref-image 连线:日志 canvas.connect(pal5-y7dj → shot...[ref-image])

幂等:已存在的节点/连线跳过;version 只在不完整时递增。
"""
import json, os, sys

HOME = os.path.expanduser('~/.bigbotart')
FILE = os.path.join(HOME, 'canvases-proj-1789363510085-tp83c.json')
TAKES = os.path.join(HOME, 'takes-proj-1789363510085-tp83c.json')
SHOT_ID = 'shot-1790001542801-gyec'
SRC_ID = 'pal5-y7dj'

with open(FILE, 'r', encoding='utf-8') as f:
    pc = json.load(f)
canvas = pc['canvases'][0]
nodes = {n['id']: n for n in canvas['nodes']}
edges = canvas['edges']

added = []
now_old = '2026-09-21T08:00:00.000Z'

# 1) 3 个 image-gen(事故前盘文件原文;resultPath 指向已落盘的生成图)
IMAGE_GEN = [
    {
        'id': 'pal2-sras',
        'label': '图片生成',
        'position': {'x': 329.9746720062651, 'y': 200.6400220427595},
        'data': {
            'engine': 'mlxgen',
            'model': 'AbstractFramework/z-image-turbo-8bit',
            'prompt': '生成一个美女全身照，中国女子，旗袍，丝袜。',
            'width': 480, 'height': 832, 'steps': 24, 'guidance': 1, 'seeds': [42],
            'resultPath': '/Users/jiangzhenguo/ai/BigBotArt/.bigbotart/outputs/images/pal2-sras_mlxgen-generate-1789886036307.png',
        },
    },
    {
        'id': 'pal4-edq6',
        'label': '图片生成',
        'position': {'x': -82.23626219022623, 'y': 169.14486388788657},
        'data': {
            'engine': 'mlxgen',
            'model': 'AbstractFramework/z-image-turbo-8bit',
            'prompt': '中国美女，丝袜，短裤，高跟鞋 ',
            'width': 576, 'height': 1024, 'steps': 24, 'guidance': 1, 'seeds': [42],
            'resultPath': '/Users/jiangzhenguo/ai/BigBotArt/.bigbotart/outputs/images/pal4-edq6_mlxgen-generate-1789969556166.png',
        },
    },
    {
        'id': 'pal5-y7dj',
        'label': '图片生成',
        'position': {'x': -84.45118634135973, 'y': -211.38726827401968},
        'data': {
            'engine': 'mlxgen',
            'model': 'AbstractFramework/z-image-turbo-8bit',
            'prompt': '半写实厚涂插画风, 3A游戏概念原画风格, 柔和边缘线条,\n微妙色彩过渡, 非照片级写实, 非日系赛璐璐, 非水彩渲染,\n礼仪官角色四视图设定板, 16:9横向, 工业级人物资产图,\n同一位城邦联盟礼仪官, 20+岁东方女性,\n冷峻面容, 精致五官, 薄唇微抿, 左眼下细小泪痣,\n银白短发微卷至下颌线, 黑色丝带耳饰,\n束腰高领内搭, 短披肩外套, 细长黑手套, 腰部仪式纹章,\n丝绸+羊毛呢+抛光银金属材质, 象牙白+冷灰+墨黑配色,\n冷灰蓝主色调, 暖金色点缀,\n正面全身, 侧面全身, 背面全身, 脸部特写, 服装细节,\n同一张脸, 同一发型, 同一服装版型,\n浅灰色纯色背景, 干净无杂物, 超高清细节,\n无文字, 无水印, 无阴影遮挡',
            'width': 1024, 'height': 1024, 'steps': 24, 'guidance': 1, 'seeds': [42],
            'resultPath': '/Users/jiangzhenguo/ai/BigBotArt/.bigbotart/outputs/images/pal5-y7dj_mlxgen-generate-1789969702928.png',
        },
    },
]

for spec in IMAGE_GEN:
    if spec['id'] not in nodes:
        canvas['nodes'].append({
            'id': spec['id'], 'kind': 'image-gen', 'label': spec['label'],
            'position': spec['position'], 'width': 224,
            'data': spec['data'],
            'createdAt': now_old, 'updatedAt': now_old,
        })
        added.append(f'node {spec["id"]}')

nodes = {n['id']: n for n in canvas['nodes']}

# 2) shot(参数来自 take)
if SHOT_ID not in nodes:
    with open(TAKES, 'r', encoding='utf-8') as f:
        td = json.load(f)
    takes = td.get('takes', td) if isinstance(td, dict) else td
    if isinstance(takes, dict):
        takes = takes.get('takes', [])
    params = None
    for t in takes:
        if t.get('shotNodeId') == SHOT_ID:
            params = t.get('params') or {}
            break
    if params is None:
        print('!! 未找到 take 参数,无法恢复 shot', file=sys.stderr)
        sys.exit(1)
    now_shot = '2026-09-21T14:41:00.000Z'
    canvas['nodes'].append({
        'id': SHOT_ID,
        'kind': 'shot',
        'label': '礼仪官脱丝袜',
        'position': {'x': 560, 'y': 120},
        'width': 250,
        'data': {
            'engine': 'h3c',
            'mode': params.get('mode', 'ref-image'),
            'prompt': params.get('prompt', ''),
            'width': params.get('width', 1280),
            'height': params.get('height', 720),
            'frames': params.get('frames', 124),
            'steps': params.get('steps', 30),
            'layers': params.get('layers', 50),
            'reuse': params.get('reuse', 1),
            'tier': params.get('tier', 'default'),
            'seed': params.get('seed', 13),
            'refs': [],
            'accel': params.get('accel', {'enabled': True, 'packId': 'turbo-t8test', 'steps': 8}),
        },
        'createdAt': now_shot,
        'updatedAt': now_shot,
    })
    added.append(f'node {SHOT_ID}')

# 3) ref-image 连线(pal5-y7dj → shot)
if SRC_ID in nodes and not any(e.get('source') == SRC_ID and e.get('target') == SHOT_ID for e in edges):
    edges.append({'id': f'restore-edge-{SHOT_ID}', 'source': SRC_ID, 'target': SHOT_ID, 'label': 'ref-image'})
    added.append('edge pal5-y7dj → shot[ref-image]')

if added:
    canvas['version'] = int(canvas.get('version', 0)) + 1
    canvas['updatedAt'] = '2026-09-21T14:55:00.000Z'
    pc['canvases'][0] = canvas
    with open(FILE, 'w', encoding='utf-8') as f:
        json.dump(pc, f, ensure_ascii=False, indent=2)
    print('已恢复:' + '; '.join(added) + f' · version={canvas["version"]}')
else:
    print('无需恢复(全部节点与连线已存在)')