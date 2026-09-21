/**
 * AddNodePopover — 「+」下游节点弹层(纯展示 + 本地 UI 状态)
 *
 * 拆分自 CanvasPage 的 add-pop 区块(原 2592–2749 行)。
 * 搜索词 / 选中类型 / 画幅档位是本组件的本地 UI 状态(行为与原 CanvasPage 一致:
 * 每次打开重置搜索与选中,画幅/档位跨打开保留);
 * 类型过滤(visibleTypes)与已连接下游(outgoing)由 CanvasPage 派生后传入。
 */
import React, { useEffect, useState } from 'react';
import type { Edge, CanvasNode } from './types';
import { NODE_TYPES, RES, resLine } from './constants';
import { resolvePortOptions, hasConnector, PORT_LABEL } from './connectors';

interface AddNodePopoverProps {
  open: boolean;
  /** 弹层左上角(world 坐标) */
  pos: { x: number; y: number };
  /** 「+」来源节点(undefined = 未打开) */
  src: CanvasNode | undefined;
  /** 来源节点标题(空态显示「—」) */
  srcLabel: string;
  /** 已连接下游(从边派生) */
  outgoing: Array<{ edge: Edge; node: CanvasNode }>;
  /** 点击已连接下游行 → 定位 + 选中该节点 */
  onLocate: (nodeId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  /** 创建并连线(选中类型 + 画幅 + 档位 + 端口角色由本组件回传;port 仅多端口组合时给出) */
  onCreate: (typeId: string, aspect: string, tier: string, port?: string) => void;
  /** 每次打开自增;变化时重置搜索/选中(画幅/档位跨打开保留) */
  openCount: number;
}

export function AddNodePopover({
  open,
  pos,
  src,
  srcLabel,
  outgoing,
  onLocate,
  onSelectNode,
  onClose,
  onCreate,
  openCount,
}: AddNodePopoverProps) {
  /* 弹层本地 UI 状态:搜索 / 选中类型 / 端口角色(多端口组合时) / 画幅 × 档位 */
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [portIdx, setPortIdx] = useState(0);
  const [aspect, setAspect] = useState('16:9');
  const [tier, setTier] = useState('默认');

  /* 每次打开重置搜索与选中(与原 CanvasPage openAddPop 行为一致) */
  useEffect(() => {
    setSearch('');
    setSel(null);
    setPortIdx(0);
  }, [openCount]);

  const q = search.trim().toLowerCase();
  /* 可选下游类型:只列有连接器的(无连接器 ⇒ 不展示),并按搜索词过滤 */
  const visibleTypes = src
    ? NODE_TYPES.filter((t) => hasConnector(src, t.id)).filter((t) => !q || t.name.toLowerCase().includes(q))
    : [];
  /* 当前选中类型的全部端口选项 + 当前选择(多端口时 UI 可选) */
  const portOpts = src && sel ? resolvePortOptions(src, sel) : [];
  const chosenPort = portOpts[Math.min(portIdx, portOpts.length - 1)] ?? null;
  const tip = sel
    ? `自动连线：${srcLabel} → ${NODE_TYPES.find((t) => t.id === sel)?.name ?? ''}${chosenPort ? ` · 落 ${chosenPort.port} 端口` : ''}`
    : '选中后自动连线并继承绑定';
  const resHint = resLine(aspect, tier);

  return (
    <div
      className={`add-pop${open ? ' open' : ''}`}
      data-od-id="node-add-popover"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ap-h">
        添加下游节点
        <span
          className="mono mut"
          style={{ marginLeft: 'auto', fontSize: '10.5px', fontWeight: 400 }}
        >
          基于：{srcLabel}
        </span>
      </div>
      {/* 已连接下游:从边派生,点击定位(连接器 D1:只见节点与端口语义) */}
      <div className="ap-conn" hidden={outgoing.length === 0}>
        <div className="ap-conn-h">
          已连接下游 · <span>{outgoing.length}</span>
        </div>
        {outgoing.map(({ edge, node }) => (
          <div
            key={edge.to}
            className="ap-conn-r"
            onClick={(e) => {
              e.stopPropagation();
              onLocate(node.id);
              onSelectNode(node.id);
              onClose();
            }}
          >
            <span className="nm">{node.title}</span>
            {edge.label ? <span className="lk">{edge.label}</span> : null}
            {node.ghost ? (
              <span className="cst">排队中</span>
            ) : node.stale ? (
              <span className="cst">
                <span className="dot" style={{ background: 'var(--warn)' }}></span>待刷新
              </span>
            ) : null}
            <span className="go">定位 →</span>
          </div>
        ))}
      </div>
      <div className="ap-s">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          placeholder="搜索节点类型…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="ap-list">
        {visibleTypes.map((t) => {
          const rpOpts = src ? resolvePortOptions(src, t.id) : [];
          const rp = rpOpts[0] ?? null;
          const multi = rpOpts.length > 1;
          /* 预览端口:选中行显示当前选择,未选中行显示默认(首个) */
          const rowPort = sel === t.id && multi ? (rpOpts[portIdx] ?? rp) : rp;
          return (
            <div
              key={t.id}
              className={`ap-row${sel === t.id ? ' sel' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setSel(t.id);
                setPortIdx(0); // 换类型重置端口选择
              }}
            >
              <div className="grow">
                <b>{t.name}</b>
                <div className="sub">{t.sub}</div>
                {rowPort ? (
                  <div className="conn">
                    <span className="lk">{PORT_LABEL[rowPort.port] ?? rowPort.port}</span>
                    {rowPort.desc}
                  </div>
                ) : null}
                {multi && sel === t.id ? (
                  <div className="ap-port">
                    <span className="lbl" style={{ marginRight: 6 }}>角色</span>
                    {rpOpts.map((o, i) => (
                      <span
                        key={o.port}
                        className={`chip${i === portIdx ? ' on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPortIdx(i);
                        }}
                      >
                        {PORT_LABEL[o.port] ?? o.port}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {t.id === 'shot' ? <span className="rec">推荐</span> : null}
              {t.p1 ? <span className="p1">P1</span> : t.wf ? <span className="p1">WF</span> : null}
            </div>
          );
        })}
        {visibleTypes.length === 0 ? (
          <div className="ap-empty">
            {q ? '无匹配的兼容节点类型' : '当前输出没有可连接的节点类型'}
          </div>
        ) : null}
      </div>
      <div className="ap-params" hidden={sel !== 'shot'}>
        {src?.kind === 'shot' ? (
          /* 接续上游镜头:比例/档位由上游继承(下游可在检查器改并转为自定义),此处不再给选择 */
          <div className="ap-res mono" style={{ borderTop: 'none', paddingTop: 2 }}>
            接续上游：画面规格继承自「{srcLabel}」（
            {String(((src.data ?? {}) as Record<string, unknown>).aspect ?? '16:9')} ·{' '}
            {String(((src.data ?? {}) as Record<string, unknown>).tier ?? 'default')}档 ·{' '}
            {String(((src.data ?? {}) as Record<string, unknown>).width ?? '')}×
            {String(((src.data ?? {}) as Record<string, unknown>).height ?? '')}）
          </div>
        ) : (
          <>
            <div className="ap-prow">
              <span className="lbl">比例</span>
              {['16:9', '9:16', '1:1'].map((a) => (
                <span
                  key={a}
                  className={`chip${aspect === a ? ' on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAspect(a);
                    setTier((t) => (t !== '默认' && !((RES[t] ?? {})[a] ?? null) ? '默认' : t));
                  }}
                >
                  {a}
                </span>
              ))}
            </div>
            <div className="ap-prow">
              <span className="lbl">档位</span>
              {['预览', '草稿', '默认', '参考'].map((t) => {
                const ok = !!((RES[t] ?? {})[aspect] ?? null);
                return (
                  <span
                    key={t}
                    className={`chip${tier === t && ok ? ' on' : ''}${ok ? '' : ' dis'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!ok) return;
                      setTier(t);
                    }}
                  >
                    {t}
                  </span>
                );
              })}
            </div>
            <div className="ap-res mono">{resHint}</div>
          </>
        )}
      </div>
      <div className="ap-f">
        <span className="grow">{tip}</span>
        <button
          className="btn btn-p btn-sm"
          disabled={!sel}
          onClick={(e) => {
            e.stopPropagation();
            if (!sel) return;
            onCreate(sel, aspect, tier, chosenPort?.port);
          }}
        >
          创建并连线
        </button>
      </div>
    </div>
  );
}