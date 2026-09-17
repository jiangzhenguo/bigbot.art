import React from 'react';

/** Agent 规划结果 → Agent 消息气泡内容 */
export function planMsg(plan: { document?: unknown; shots?: unknown[]; report?: string; brief?: string }): React.ReactNode {
  const doc = plan.document as { data?: { markdown?: string }; label?: string } | undefined;
  const md = doc?.data?.markdown ?? plan.brief ?? '';
  const shots = plan.shots ?? [];
  return (
    <>
      <b>执行计划（已落到画布）</b>
      {md ? (
        <div className="mut" style={{ marginTop: 4, fontSize: '11px', whiteSpace: 'pre-wrap' }}>
          {md.slice(0, 240)}
        </div>
      ) : null}
      <div style={{ marginTop: 6 }}>
        <div className="step">
          <span className="sm sm-done">✓</span>
          <div>
            <b>创建 Brief 文档节点</b>
            <div className="mut" style={{ fontSize: '11px' }}>
              画布左侧 · 可编辑后增量重规划
            </div>
          </div>
        </div>
        <div className="step">
          <span className="sm sm-done">✓</span>
          <div>
            <b>分镜规划 {shots.length} 镜头</b>
            <div className="mut" style={{ fontSize: '11px' }}>
              {(plan.report ?? '').split('\n')[0] || '已按 H3 五段式拆分'}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
