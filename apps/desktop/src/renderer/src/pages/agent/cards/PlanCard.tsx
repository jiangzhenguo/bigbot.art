/**
 * PlanCard — 执行计划卡(agentPlan / 首页规划落地后的消息)
 * 由 canvas/plan-msg.tsx 迁移:消息只存 PlanData,渲染归本组件。
 */
import React from 'react';
import type { PlanData } from '../types';

export function PlanCard({ plan }: { plan: PlanData }) {
  const doc = plan.document as { data?: { markdown?: string }; label?: string } | undefined;
  const md = doc?.data?.markdown ?? plan.brief ?? '';
  const shots = plan.shots ?? [];
  return (
    <div className="msg-agent" data-od-id="agent-plan">
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
    </div>
  );
}

export default PlanCard;
