/**
 * 连接器能力表 — Agent 可见的「谁能连谁 + 端口语义」
 *
 * 渲染层 connectors.ts(BY_KIND)是权威的连线判定;这里维护一份同构的摘要版,
 * 供主进程 tool-handlers 生成给 Agent 的能力说明(canvas.connectors / 对话注入),
 * 并作为本次新增 storyboard/document 端口的事实源。
 *
 * 规则:源 kind → 目标 kind → 端口语义(即连线 label)。
 */

/** 源节点 kind → 目标 kind → 端口(label) */
export const CONNECTOR_MAP: Record<string, Record<string, string>> = {
  shot: {
    shot: 'first-frame', // 上游尾帧作为下游首帧(镜头接续链)
    edit: 'input', // 取帧作为输入图
    timeline: 'clip', // 整段入轨
  },
  'image-gen': {
    shot: 'first-frame', // 静帧直通首帧
    edit: 'input',
    upscale: 'input',
    image: 'ref-image', // 参考图
    timeline: 'clip',
  },
  'image-edit': {
    shot: 'first-frame',
    edit: 'input',
    upscale: 'input',
    timeline: 'clip',
  },
  'image-upscale': {
    shot: 'first-frame',
    edit: 'input',
    image: 'ref-image',
    timeline: 'clip',
  },
  'audio-ref': {
    shot: 'ref-audio', // 音轨参考(带声直出)
    timeline: 'audio-track',
  },
  document: {
    image: 'prompt', // 提示词 · 全文/选段注入
    shot: 'prompt',
    edit: 'prompt',
    doc: 'prompt',
    director: 'prompt',
    storyboard: 'prompt', // 分镜依据
  },
  storyboard: {
    image: 'prompt', // 提示词 · 按行注入(铺节点物化)
    shot: 'prompt',
    edit: 'prompt',
    timeline: 'sequence', // 分镜序列 · 按行入轨
    director: 'prompt',
  },
  director: {
    timeline: 'sequence',
    doc: 'prompt',
  },
  timeline: {
    doc: 'prompt',
  },
  'workflow-input': {
    '*': 'slot-<名称>', // 按槽位类型匹配目标端口
  },
};

/** 目标类型兜底:任何产物型节点可收口到工作流出口 */
export const CONNECTOR_OUTPUT_TARGET = 'wf-output';

/** 端口语义字典(给 Agent 解释 label 含义) */
export const PORT_SEMANTICS: Record<string, string> = {
  prompt: '提示词注入(文档/分镜表 → 生成节点)',
  'first-frame': '首帧直通(图片/上游尾帧 → 镜头)',
  'last-frame': '尾帧条件(FL2VA)',
  'ref-image': '参考图(Ref2VA 身份/场景锁定)',
  'ref-audio': '音轨参考(带声直出)',
  'ref-video': '参考视频(风格/动作参考)',
  input: '输入图/输入帧(编辑/超分源)',
  clip: '视频/静帧入轨(时间线)',
  sequence: '镜头编排序列入轨',
  'audio-track': '音轨随片导出',
  'slot-<名称>': '工作流入口槽位注入',
  output: '产物汇聚收口(工作流出口)',
};

/** 人读的连接器能力摘要(给 Agent system prompt / 工具返回) */
export function connectorSummary(): string {
  const lines: string[] = [];
  const outRows = ['shot', 'director', 'audio-ref', 'image-gen', 'image-edit', 'image-upscale', 'asset'];
  for (const [src, targets] of Object.entries(CONNECTOR_MAP)) {
    const per: string[] = [];
    for (const [dst, port] of Object.entries(targets)) {
      per.push(dst === '*' ? '任意操作节点(slot-<名称>)' : `${dst} → ${port}(${PORT_SEMANTICS[port] ?? port})`);
    }
    if (src !== 'workflow-input') {
      per.push(`${CONNECTOR_OUTPUT_TARGET} → output(${PORT_SEMANTICS.output})`);
    }
    lines.push(`- ${src}:可连 ${per.join(';')}`);
  }
  lines.push(`- 收口到 ${CONNECTOR_OUTPUT_TARGET}:${outRows.join('/')}`);
  return lines.join('\n');
}

/** 节点类型清单(给 Agent 认知画布节点:含本次新增 storyboard) */
export const NODE_KIND_GUIDE = [
  ['document', '文档/提示词:Markdown(含 GFM 表格与 ```prompt / #shot-N 选段标记)'],
  ['storyboard', '分镜表(脚本):Markdown 表格,一行 = 一个分镜;可「从分镜表生成节点」铺 shot/image-gen'],
  ['asset', '资产引用(图片/视频/音频/文档)'],
  ['image-gen', '图片生成(mlxgen 文生图)'],
  ['image-edit', '图片编辑(指令/I2I/Inpaint/Outpaint)'],
  ['image-upscale', '图片增强(超分)'],
  ['shot', '视频镜头(h3.c:文生/首帧/首尾帧/参考图)'],
  ['director', '导演台(运镜参考小样)'],
  ['timeline', '时间线/剪辑(FFmpeg 导出)'],
  ['audio-ref', '音频参考(--ref-audio)'],
  ['workflow-input', '工作流入口(声明输入槽位)'],
  ['workflow-output', '工作流出口(产物汇聚)'],
] as const;

export function nodeKindGuide(): string {
  return NODE_KIND_GUIDE.map(([k, d]) => `- ${k}:${d}`).join('\n');
}