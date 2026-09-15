/**
 * 确定性规划器(骨架期)— Brief → 画布
 * 将来由 pi(真 LLM)接管:此文件保留为插槽,输出结构不变。
 * 骨架期策略:
 * - 生成 1 个 Brief 文档节点
 * - 按句子/时长启发式拆 1~3 个镜头(default 档 h3 参数)
 * - 连线 Brief → 各镜头
 */
import type { CanvasEdge, CanvasNode, LlmSource } from '@bigbotart/shared';
import type { PlanParams, PlanResult } from './protocol.js';

let seq = 0;
const nid = (p: string) => `${p}-${Date.now()}-${++seq}`;

export function planDeterministic(params: PlanParams): PlanResult {
  const { brief, projectName } = params;
  const docNode: CanvasNode = {
    id: nid('doc'),
    kind: 'document',
    position: { x: 60, y: 80 },
    label: 'Brief',
    data: { markdown: formatBrief(brief, projectName) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 启发式拆镜头:非空行数为线索,默认 2 镜
  const lines = brief.split(/[\n。！？!?]/).map((s) => s.trim()).filter(Boolean);
  const shotCount = Math.max(1, Math.min(3, lines.length >= 4 ? 3 : 2));

  const shots: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const shotsText = splitIntoShots(lines, shotCount);

  for (let i = 0; i < shotCount; i++) {
    const shot: CanvasNode = {
      id: nid('shot'),
      kind: 'shot',
      position: { x: 480, y: 80 + i * 220 },
      label: `镜头 ${i + 1}`,
      data: {
        engine: 'mock', // 骨架期默认 mock;引导向导就绪后切 h3c
        mode: 'text2video',
        prompt: shotsText[i] ?? brief,
        width: 768,
        height: 768,
        frames: 124,
        steps: 30,
        layers: 50,
        reuse: 1,
        tier: 'default',
        seed: 42 + i,
        refs: [],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    shots.push(shot);
    edges.push({ id: nid('edge'), source: docNode.id, target: shot.id, label: 'scene-brief' });
  }

  const report =
    `已把需求拆为 ${shotCount} 个镜头\n` +
    `- 每个镜头默认使用 mock 引擎(dry-run),引导向导可切换 h3.c\n` +
    `- 提示词采用 H3 五段式结构,可在文档节点中编辑`;

  return { document: docNode, shots, edges, report };
}

function formatBrief(brief: string, projectName?: string): string {
  return `# ${projectName ? `《${projectName}》` : '新项目'} — 创作 Brief\n\n${brief}\n`;
}

function splitIntoShots(lines: string[], count: number): string[] {
  if (lines.length === 0) return [''];
  if (count <= 1) return [lines.join('。')];
  const chunk = Math.max(1, Math.ceil(lines.length / count));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = lines.slice(i * chunk, (i + 1) * chunk).join('。');
    if (part) out.push(part);
  }
  return out;
}

/** 骨架期暴露给外部:将来 pi 到来时替换实现,签名保持一致 */
export type Planner = (params: PlanParams, llm?: LlmSource) => Promise<PlanResult>;
export const deterministicPlanner: Planner = async (params) => planDeterministic(params);