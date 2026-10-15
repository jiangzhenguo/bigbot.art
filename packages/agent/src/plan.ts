/**
 * 确定性规划器(骨架期)— Brief → 画布
 * 将来由 pi(真 LLM)接管:此文件保留为插槽,输出结构不变。
 * 骨架期策略:
 * - 生成 1 个 Brief 文档节点
 * - 按句子/时长启发式拆 1~3 个镜头(default 档 h3 参数)
 * - 连线 Brief → 各镜头
 * - plan-storyboard:把需求拆成一张分镜表(表格),默认只出表(分步),autoMaterialize 时同时铺节点
 */
import type { CanvasEdge, CanvasNode, LlmSource } from '@bigbotart/shared';
import {
  assembleH3Prompt,
  assembleZImagePrompt,
  rowNeedsImage,
  rowSeconds,
  rowCell,
  resolveMaterializeSeconds,
  normalizeShotDuration,
  storyboardMarkdown,
  tableToGfm,
  STORYBOARD_HEAD,
  SB_SIZE,
  planStoryboardMaterializeRows,
} from '@bigbotart/shared';
import type { PlanParams, PlanResult, PlanStoryboardParams, PlanStoryboardResult } from './protocol.js';

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

/* ═══ plan-storyboard:确定性模板(分镜表) ═══ */

/** 自动档:按表格铺出 shot/image-gen 节点与连线(与渲染层 / Agent materialize 同构) */
export function buildStoryboardMaterialized(
  storyboardId: string,
  head: string[],
  rows: string[][],
  basePrompt?: string,
  canvasNodes?: CanvasNode[],
): { images: CanvasNode[]; shots: CanvasNode[]; edges: CanvasEdge[] } {
  const images: CanvasNode[] = [];
  const shots: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const size = SB_SIZE['16:9']!;
  const plans = planStoryboardMaterializeRows({
    head,
    rows,
    canvasNodes: canvasNodes ?? [],
  });
  const shotIdByRow = new Map<number, string>();
  for (const plan of plans) {
    const r = plan.rowNo - 1;
    const row = rows[r] ?? [];
    const promptText = assembleH3Prompt(row, head, basePrompt, plan.subjects).text;
    const sec = resolveMaterializeSeconds(
      rowSeconds(row, head),
      rowCell(row, head, '画面描述'),
      rowCell(row, head, '提示词(可选)'),
      promptText,
    );
    const dur = normalizeShotDuration(
      { prompt: promptText, seconds: sec || undefined },
      { label: `镜头 ${String(plan.rowNo).padStart(2, '0')}`, prompt: promptText },
    );
    const shot: CanvasNode = {
      id: nid('shot'),
      kind: 'shot',
      position: { x: 880, y: 80 + r * 186 },
      label: `镜头 ${String(plan.rowNo).padStart(2, '0')}`,
      data: {
        engine: 'mock',
        mode: plan.shotMode,
        ...(plan.modeOverride ? { modeOverride: true } : {}),
        prompt: promptText,
        width: size.width,
        height: size.height,
        seconds: Number(dur.data.seconds),
        frames: Number(dur.data.frames),
        steps: 30,
        layers: 50,
        reuse: 1,
        tier: 'default',
        seed: 42 + r,
        refs: [],
        promptFrom: { nodeId: storyboardId, mode: 'row', row: plan.rowNo },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    shots.push(shot);
    shotIdByRow.set(plan.rowNo, shot.id);
    edges.push({ id: nid('edge'), source: storyboardId, target: shot.id, label: 'prompt' });

    if (plan.strategy === 'continue' && plan.continueFromRow != null) {
      const prevId = shotIdByRow.get(plan.continueFromRow);
      if (prevId) edges.push({ id: nid('edge'), source: prevId, target: shot.id, label: 'first-frame' });
    }
    for (const refId of plan.refNodeIds) {
      edges.push({ id: nid('edge'), source: refId, target: shot.id, label: 'ref-image' });
    }
    if (plan.createKeyframe) {
      const img: CanvasNode = {
        id: nid('img'),
        kind: 'image-gen',
        position: { x: 620, y: 80 + r * 186 },
        label: `图片生成 · 分镜静帧 ${String(plan.rowNo).padStart(2, '0')}`,
        data: {
          engine: 'mlxgen',
          // 🆕 不写 model(2026-09-29 v1 工具模型)/ steps(2026-10-14 按模型缺省,Turbo=8):
          // 留给提交期按「节点显式值 > 设置页工具模型 > 内置默认」解析;
          // 这里写死 z-image+24 会让设置页配置与 Turbo 锁步全部失效
          prompt: assembleZImagePrompt(row, head, basePrompt).text,
          width: size.width,
          height: size.height,
          guidance: 1.0,
          seeds: [42],
          promptFrom: { nodeId: storyboardId, mode: 'row', row: plan.rowNo },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      images.push(img);
      edges.push({ id: nid('edge'), source: storyboardId, target: img.id, label: 'prompt' });
      edges.push({ id: nid('edge'), source: img.id, target: shot.id, label: 'first-frame' });
    }
  }
  return { images, shots, edges };
}

export function planStoryboardDeterministic(params: PlanStoryboardParams): PlanStoryboardResult {
  const { brief, projectName, basePrompt } = params;
  const lines = brief
    .split(/[\n。！？!?]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const count = Math.max(1, Math.min(4, lines.length >= 6 ? 4 : lines.length >= 3 ? 3 : 2));
  const segments = splitIntoShots(lines, count);
  const head = [...STORYBOARD_HEAD] as string[];
  const rows = segments.map((seg, i) => [
    String(i + 1),
    seg || `场景片段 ${i + 1}`,
    '',
    '中景',
    '固定',
    String(4 + (i % 3)),
    '是',
    '',
  ]);
  const gfm = tableToGfm(head, rows);
  const noun = projectName ? `《${projectName}》` : '新分镜';
  const md = storyboardMarkdown(
    `${noun} · 分镜表`,
    `由需求拆解为 ${count} 个镜头;人物镜头沿用 reuse 1 / layers 50,身份措辞显式锁定。`,
    head,
    rows,
  );
  const storyboard: CanvasNode = {
    id: nid('sb'),
    kind: 'storyboard',
    position: { x: 420, y: 80 },
    label: `${noun} · 分镜表`,
    data: { markdown: md, basePrompt: basePrompt ?? '', lastTable: gfm, aspect: '16:9', tier: 'default' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { images, shots, edges } = params.autoMaterialize
    ? buildStoryboardMaterialized(storyboard.id, head, rows, basePrompt)
    : { images: [], shots: [], edges: [] };
  const report = `已生成分镜表:${count} 行 · ${rows.filter((r) => rowNeedsImage(r, head)).length} 行需配图${
    params.autoMaterialize ? ` · 已铺出 ${shots.length} shot + ${images.length} image-gen` : ' · 分步模式(未铺节点)'
  }`;
  return { storyboard, images, shots, edges, report };
}

export type StoryboardPlanner = (params: PlanStoryboardParams, llm?: LlmSource) => Promise<PlanStoryboardResult>;
export const deterministicStoryboardPlanner: StoryboardPlanner = async (params) => planStoryboardDeterministic(params);