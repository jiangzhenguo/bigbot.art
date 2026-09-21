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
    // 图生视频双端口:first-frame 静帧直通首帧(FL2VA)/ ref-image 参考图注入(Ref2VA 身份/场景锁定)
    shot: 'first-frame/ref-image',
    edit: 'input',
    upscale: 'input',
    crop: 'input', // 原图裁切源
    image: 'ref-image', // 参考图
    timeline: 'clip',
  },
  'image-edit': {
    shot: 'first-frame/ref-image',
    edit: 'input',
    upscale: 'input',
    crop: 'input', // 原图裁切源
    timeline: 'clip',
  },
  'image-upscale': {
    shot: 'first-frame/ref-image',
    edit: 'input',
    crop: 'input', // 原图裁切源
    image: 'ref-image',
    timeline: 'clip',
  },
  'image-crop': {
    shot: 'first-frame/ref-image', // 裁切结果 → 首帧直通 / 参考图注入
    edit: 'input', // 裁切结果作输入图
    upscale: 'input',
    image: 'ref-image', // 裁切结果作参考图
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
  // 资产引用:端口按媒体类型动态(渲染层 connectors.ts 四类矩阵为准,此处给 Agent 综合摘要)
  asset: {
    shot: 'first-frame/ref-image/ref-video/ref-audio/prompt', // 按媒体类型:图片=首帧参考(first-frame)/参考图(ref-image) · 视频 ref-video · 音频 ref-audio · 文档 prompt
    image: 'ref-image', // 图片参考图(Ref2VA/风格)
    edit: 'input', // 输入图/取帧源
    upscale: 'input', // 超分源
    crop: 'input', // 裁切源
    timeline: 'clip', // 静帧/视频素材入轨;音频为 audio-track
    doc: 'prompt', // 文档资产 → 文档引用
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

/** 单值端口:同一目标节点上该端口至多一条入边(多值端口:ref-image/prompt/clip/sequence/output/slot-*) */
export const SINGLE_VALUE_PORTS = new Set(['first-frame', 'last-frame', 'input', 'ref-audio', 'ref-video']);

/** 人读的连接器能力摘要(给 Agent system prompt / 工具返回) */
export function connectorSummary(): string {
  const lines: string[] = [];
  const outRows = ['shot', 'director', 'audio-ref', 'image-gen', 'image-edit', 'image-upscale', 'asset'];
  for (const [src, targets] of Object.entries(CONNECTOR_MAP)) {
    const per: string[] = [];
    for (const [dst, port] of Object.entries(targets)) {
      if (dst === '*') {
        per.push('任意操作节点(slot-<名称>)');
        continue;
      }
      const single = port.split('/').some((p) => SINGLE_VALUE_PORTS.has(p.trim()))
        ? '·单值端口(同一目标该端口只能一条入边,重复连自动替换旧边)'
        : '';
      per.push(`${dst} → ${port}(${PORT_SEMANTICS[port] ?? port})${single}`);
    }
    if (src !== 'workflow-input') {
      per.push(`${CONNECTOR_OUTPUT_TARGET} → output(${PORT_SEMANTICS.output})`);
    }
    lines.push(`- ${src}:可连 ${per.join(';')}`);
  }
  lines.push(`- 收口到 ${CONNECTOR_OUTPUT_TARGET}:${outRows.join('/')}`);
  lines.push('⚠️ 端口基数:first-frame/last-frame/input/ref-audio/ref-video 是单值端口,同一目标节点只允许一条入边;ref-image/prompt/clip/sequence/output 可多条。写边前系统会强制校验,不合法会被拒绝,单值端口重复连会自动替换旧边。');
  return lines.join('\n');
}

/** 节点类型清单(给 Agent 认知画布节点:含本次新增 storyboard) */
export const NODE_KIND_GUIDE = [
  ['document', '文档/提示词:Markdown(含 GFM 表格与 ```prompt / #shot-N 选段标记)'],
  ['storyboard', '分镜表(脚本):Markdown 表格,一行 = 一个分镜;可「从分镜表生成节点」铺 shot/image-gen'],
  ['asset', '资产引用(图片/视频/音频/文档)'],
  ['image-gen', '图片生成(mlxgen 文生图)'],
  ['image-edit', '图片编辑(指令/I2I/Inpaint/Outpaint)'],
  ['image-crop', '图片裁切(按目标画幅裁剪,如 1:1 → 9:16,供下游作输入图)'],
  ['image-upscale', '图片增强(超分)'],
  ['shot', '视频镜头(h3.c:文生/首帧/首尾帧/参考图;支持 🚀 加速 LoRA:data.accel={enabled,packId,steps},packId 经 accel.list 查蒸馏包并沿用其 steps,开启后提交自动用蒸馏包+少步数)'],
  ['director', '导演台(运镜参考小样)'],
  ['timeline', '时间线/剪辑(FFmpeg 导出)'],
  ['audio-ref', '音频参考(--ref-audio)'],
  ['workflow-input', '工作流入口(声明输入槽位)'],
  ['workflow-output', '工作流出口(产物汇聚)'],
] as const;

export function nodeKindGuide(): string {
  return NODE_KIND_GUIDE.map(([k, d]) => `- ${k}:${d}`).join('\n');
}