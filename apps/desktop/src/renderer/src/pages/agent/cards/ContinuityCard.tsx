/**
 * ContinuityCard — 连续性校验卡(引擎任务完成后自动触发,校验 Agent 自动播报)
 */
import React from 'react';
import type { CheckData } from '../types';

export function ContinuityCard({ check }: { check: CheckData }) {
  return (
    <div className="msg-agent" data-od-id="agent-check">
      <b className="mut">校验 Agent（自动）</b>
      <div className="mut" style={{ marginTop: 4, fontSize: '11px' }}>
        {check.issues.length ? check.issues.join('；') : (check.result ?? '连续性校验通过')}
      </div>
    </div>
  );
}

export default ContinuityCard;
