#!/usr/bin/env python3
"""
一次性回填:节点有产物、但 Take 表里该节点一条记录都没有(历史缺口)。

事故来源(2026-09-28):Agent 侧 engine.submit 漏传 projectId/canvasId/takeId,
队列完成时 onJobFinish 两个归档分支全落空 → Take 从未创建,检查器的 attempt 列表 /
Take 切换 / timeline.export(优先读 currentTakeId)对该节点全空。
代码侧已修(tool-handlers.ts + index.ts),本脚本只补**存量数据**。

设计原则(对齐 AGENTS.md R5:用户数据不可逆,只增不改):
  - 只 append,绝不修改/删除已有 Take
  - 幂等:该节点若已有任意 Take 记录则跳过(可反复运行)
  - 保守:只补「节点有 resultPath 且文件真实存在」的节点
  - 补出的 Take 标注 backfilled=True + 来源说明,便于日后辨识是回填而非原生记录
  - attempt 接续该节点已有最大 attempt(缺口节点本来没有记录 → 从 1 开始)
  - createdAt 从产物文件名里的毫秒时间戳反推(拿不到则用文件 mtime)

用法:
  python3 scripts/backfill-takes.py            # dry-run,只打印将写入什么
  python3 scripts/backfill-takes.py --apply    # 真正写盘(写入前自动再备份一次)
"""
import json
import os
import re
import sys
import glob
import shutil
from datetime import datetime, timezone

HOME = os.environ.get('BIGBOTART_HOME', os.path.expanduser('~/.bigbotart'))
APPLY = '--apply' in sys.argv

# 产物文件名形如 <nodeId>_<provider>-<action>-<epochMs>.<ext>,取最后一段数字当创建时间
TS_RE = re.compile(r'-(\d{13})\.')


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def save(p, doc):
    """原子写:先写临时文件再 rename,避免半截 JSON 损坏用户数据"""
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


def created_at_from(result_path):
    """从产物文件名反推 ISO 时间;失败则用文件 mtime;再失败用当前时间"""
    m = TS_RE.search(os.path.basename(result_path))
    if m:
        return datetime.fromtimestamp(int(m.group(1)) / 1000, tz=timezone.utc).isoformat()
    if os.path.exists(result_path):
        return datetime.fromtimestamp(os.path.getmtime(result_path), tz=timezone.utc).isoformat()
    return datetime.now(tz=timezone.utc).isoformat()


def main():
    total = 0
    for cf in sorted(glob.glob(os.path.join(HOME, 'canvases-proj-*.json'))):
        pid = os.path.basename(cf)[len('canvases-'):-len('.json')]
        tf = os.path.join(HOME, f'takes-{pid}.json')
        cv = load(cf)
        doc = load(tf) if os.path.exists(tf) else {'takes': []}
        takes = doc.setdefault('takes', [])

        have_nodes = {t.get('shotNodeId') for t in takes if t.get('shotNodeId')}
        # 项目级备份(仅 apply 时)
        pending = []

        for canvas in cv.get('canvases', []):
            for n in canvas.get('nodes', []):
                d = n.get('data') or {}
                rp = d.get('resultPath')
                if not rp:
                    continue
                if n['id'] in have_nodes:
                    continue                      # 幂等:已有记录,跳过
                if not os.path.exists(rp):
                    print(f"  ⏭️  跳过 {n['id']}:产物文件不存在 {rp}")
                    continue
                pending.append({
                    'id': f"take-backfill-{int(datetime.now().timestamp()*1000)}-{n['id'][:6]}",
                    'attempt': 1,                  # 缺口节点无历史,从 1 开始
                    'createdAt': created_at_from(rp),
                    'finishedAt': created_at_from(rp),
                    'shotNodeId': n['id'],
                    'status': 'succeeded',
                    'resultPath': rp,
                    'params': {},
                    # 标记来源,便于日后辨识:这条是回填的,不是当时真实写入的
                    'backfilled': True,
                    'note': '历史缺口回填(2026-09-28 Agent 提交漏传 projectId/takeId 事故)',
                })

        if not pending:
            continue

        print(f"\n【{pid}】将补 {len(pending)} 条 Take:")
        for t in pending:
            print(f"   node={t['shotNodeId']} attempt={t['attempt']} createdAt={t['createdAt']}")
            print(f"      resultPath={t['resultPath']}")

        if APPLY:
            bak = tf + '.prebackfill'
            if os.path.exists(tf):
                shutil.copy2(tf, bak)
                print(f"   🛟 已备份 → {os.path.basename(bak)}")
            takes.extend(pending)
            save(tf, doc)
            print(f"   ✅ 已写入 {tf}")
        total += len(pending)

    print(f"\n{'已回填' if APPLY else '将回填'} {total} 条 Take"
          f"{'' if APPLY else ' (dry-run,加 --apply 真正写入)'}")


if __name__ == '__main__':
    main()
