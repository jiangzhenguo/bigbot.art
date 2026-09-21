/**
 * PortPickPop — 连线角色选择弹层(纯展示 + 轻量交互)
 *
 * 触发场景:拖拽连线命中「多端口组合」时(asset 图 → shot,可选「首帧参考 / 参考图参考」),
 * 由 CanvasPage 在指针位置开出本弹层,选定端口后调用方写边;点外 / Escape 关闭。
 * 与 ContextMenu / AssetPickerPop 同款 `.pop` 样式。
 */
import React, { useEffect, useRef } from 'react';
import type { PortResolution } from './connectors';
import { PORT_LABEL } from './connectors';

interface PortPickPopProps {
  /** 锚点(视口坐标);null = 关闭 */
  pos: { x: number; y: number } | null;
  /** 候选端口(通常 2 个) */
  options: PortResolution[];
  onPick: (port: string) => void;
  onClose: () => void;
}

export function PortPickPop({ pos, options, onPick, onClose }: PortPickPopProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* 点外 / Escape 关闭 */
  useEffect(() => {
    if (!pos) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current && wrapRef.current.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pos, onClose]);

  if (!pos || options.length === 0) return null;

  return (
    <div
      ref={wrapRef}
      className="pop open"
      data-od-id="connector-port-pick"
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(pos.x, window.innerWidth - 236 - 8)),
        top: Math.max(8, Math.min(pos.y, window.innerHeight - 110 - 8)),
        minWidth: 230,
        display: 'flex',
        flexDirection: 'column',
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pop-cap">选择连线角色</div>
      {options.map((o) => (
        <button
          key={o.port}
          className="pop-it"
          data-od-id={`connector-port-${o.port}`}
          style={{ width: '100%', textAlign: 'left' }}
          onClick={() => {
            onPick(o.port);
            onClose();
          }}
        >
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
            {PORT_LABEL[o.port] ?? o.port}
          </span>
          <span className="asub" style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>
            {o.desc}
          </span>
        </button>
      ))}
    </div>
  );
}