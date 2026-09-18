/**
 * ThinkingBlock — 模型思考内容折叠块(默认收起,点开看全文)
 * 数据来源:worker 拆出的 thinking 字段(reasoning 块 / <think> 段),不进记忆。
 */
import React from 'react';

export function ThinkingBlock({ thinking }: { thinking: string }) {
  return (
    <details className="think">
      <summary>思考过程</summary>
      <pre>{thinking}</pre>
    </details>
  );
}

export default ThinkingBlock;
