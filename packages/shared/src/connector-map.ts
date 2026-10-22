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
    // 镜头成片三端口:first-frame 上游尾帧作首帧(接续链)/ ref-video 整段成片作 Ref2VA 参考(h3 --ref-video)
    // / ref-audio 上游成片的**内嵌音轨**作声音参考(2026-10-08 新增:提交时 ffmpeg 抽出 wav 再走 --ref-audio)
    shot: 'first-frame/ref-video/ref-audio',
    // ⚠️ 不提供 shot → edit:图片编辑的 input 要静帧,视频须先经 frame-grab 落成图片
    //(直连会造出「shared 判定无可用端口」的裸边 ⇒ 节点不停闪烁,2026-09 事故)
    'frame-grab': 'input-video', // 从镜头成片裁切取帧 → 图片资源
    'video-upscale': 'input', // 镜头成片 → 视频增强(超分 + 修脸)
    // 🆕 视频 → 音频参考节点(2026-10-08):把成片的**内嵌音轨**抽出来喂给音频参考节点,
    // 由它再转给下游镜头(--ref-audio)。抽音由 ffmpeg 完成,产物落资产库并自动绑定。
    'audio-ref': 'input-audio',
    timeline: 'clip', // 整段入轨
  },
  'image-gen': {
    // 图生视频双端口:first-frame 静帧直通首帧(FL2VA)/ ref-image 参考图注入(Ref2VA 身份/场景锁定)
    shot: 'first-frame/ref-image',
    edit: 'input/ref-image',
    upscale: 'input',
    crop: 'input', // 原图裁切源
    stitch: 'piece', // 拼接件(多值,按画布位置排序)
    split: 'input', // 拆分源
    image: 'ref-image', // 参考图
    timeline: 'clip',
  },
  'image-edit': {
    shot: 'first-frame/ref-image',
    edit: 'input/ref-image',
    upscale: 'input',
    crop: 'input', // 原图裁切源
    stitch: 'piece',
    split: 'input', // 拆分源
    // 🆕 参考图 → 多参考编辑(2026-09-29):Qwen-Image-2.1 的 `qwen21.edit` 支持 1-10 张参考图。
    // 此前该端口只挂在 image-gen 上,导致 2.1 的多图参考「Provider 写了但用户画不出边」
    // (详见 docs/工具模型选择-产品设计与技术方案.md §2.1.0b)。
    // ref-image 是**多值端口**(不在 SINGLE_VALUE_PORTS),故天然允许连多条。
    image: 'ref-image',
    timeline: 'clip',
  },
  'image-upscale': {
    shot: 'first-frame/ref-image',
    edit: 'input/ref-image',
    crop: 'input', // 原图裁切源
    stitch: 'piece',
    split: 'input', // 拆分源
    image: 'ref-image',
    timeline: 'clip',
  },
  // 🆕 视频增强(超分 + 合修脸):视频入 → 视频出;可作镜头首帧/参考视频,可入轨
  'video-upscale': {
    shot: 'first-frame/ref-video/ref-audio', // 增强结果 → 首帧直通 / 参考视频(风格/动作)/ 内嵌音轨作声音参考
    'frame-grab': 'input-video', // 从增强成片取帧 → 图片资源
    'audio-ref': 'input-audio', // 增强成片的音轨 → 音频参考节点(同 shot → audio-ref)
    timeline: 'clip', // 增强成片入轨
    'video-upscale': 'input', // 链式二次增强
  },
  'image-crop': {
    shot: 'first-frame/ref-image', // 裁切结果 → 首帧直通 / 参考图注入
    edit: 'input/ref-image', // 裁切结果作输入图
    upscale: 'input',
    stitch: 'piece',
    split: 'input', // 拆分源
    image: 'ref-image', // 裁切结果作参考图
    timeline: 'clip',
  },
  'image-stitch': {
    shot: 'first-frame/ref-image', // 拼接结果 → 首帧直通 / 参考图注入
    edit: 'input/ref-image', // 拼接结果作输入图
    upscale: 'input',
    crop: 'input',
    stitch: 'piece', // 拼接结果可再作拼接件
    split: 'input', // 拼接长图再切片(拼接→拆分回路)
    image: 'ref-image',
    timeline: 'clip',
  },
  'image-split': {
    // 拆分产物多片:下游经 piece-N 端口按序号取片(piece-1 缺省 = 第 1 片)
    shot: 'first-frame/ref-image', // 选定片 → 首帧直通 / 参考图注入
    edit: 'input/ref-image', // 选定片作输入图
    upscale: 'input',
    crop: 'input',
    stitch: 'piece', // 选定片作拼接件(拆分→拼接回路)
    split: 'input',
    image: 'ref-image',
    timeline: 'clip',
  },
  'audio-ref': {
    shot: 'ref-audio', // 音轨参考(带声直出)
    timeline: 'audio-track',
  },
  // 🆕 视频裁切取帧:产物是**图片** → 与其它图片产物同类(视频 → 图片的合法转换点)
  'frame-grab': {
    shot: 'first-frame/ref-image', // 裁切出的静帧 → 首帧直通 / 参考图注入
    edit: 'input/ref-image', // 裁切出的静帧作输入图
    upscale: 'input',
    crop: 'input',
    stitch: 'piece',
    split: 'input',
    image: 'ref-image',
    timeline: 'clip',
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
    /* 🆕 成片是视频产物(2026-10 用户反馈:「+」弹层应与其它视频节点同类):
       导出成功后 data.resultPath = 成片绝对路径,下游解析与其它视频产物节点同口径。
       注意**不提供 first-frame**:该端口载荷是静帧,成片首帧须先经 frame-grab 落成图片
       (与 video-upscale 同 —— 直连会被 PORT_REQUIRED_MEDIA 的 image 要求拒掉)。 */
    shot: 'ref-video/ref-audio', // 成片作参考视频(风格/动作)/ 内嵌音轨作声音参考
    'frame-grab': 'input-video', // 从成片裁切取帧 → 图片资源
    'video-upscale': 'input', // 成片再增强(超分/修脸)
    'audio-ref': 'input-audio', // 抽成片的内嵌音轨 → 音频参考节点
    timeline: 'clip', // 成片入另一条时间线
    doc: 'prompt',
  },
  // 资产引用:端口按媒体类型动态(渲染层 connectors.ts 四类矩阵为准,此处给 Agent 综合摘要)
  asset: {
    shot: 'first-frame/ref-image/ref-video/ref-audio/prompt', // 按媒体类型:图片=首帧参考(first-frame)/参考图(ref-image) · 视频 ref-video · 音频 ref-audio · 文档 prompt
    image: 'ref-image', // 图片参考图(默认 → 2.1 参考编辑;显式选 Klein 才走 multi-reference)
    edit: 'input/ref-image', // 输入图/取帧源
    upscale: 'input', // 超分源
    crop: 'input', // 裁切源
    stitch: 'piece', // 拼接件(图片素材)
    split: 'input', // 拆分源(图片素材)
    'frame-grab': 'input-video', // 视频素材 → 裁切取帧(视频素材生成静帧的唯一通道)
    'video-upscale': 'input', // 视频素材 → 视频增强(超分 + 修脸)
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
  'ref-image': '参考图(→ shot 是 Ref2VA 身份/场景锁定;→ image-gen 默认走 Qwen-Image-2.1 参考编辑(1-10 张),显式选 flux.2-klein 才是多参考生成;→ image-edit 是指令/参考编辑)',
  'ref-audio': '音轨参考(带声直出)',
  'ref-video': '参考视频(风格/动作参考;→ shot 时走 h3 --ref-video,默认连同源片内嵌音轨一起注入,可在检查器勾「忽略音轨」改走 --ref-silent-video)',
  input: '输入图/输入帧(编辑/超分源;→ video-upscale 时是待增强视频)',
  'input-video': '输入视频(→ video-upscale 待增强;→ frame-grab 待裁切取帧)',
  'input-audio': '输入音频(→ audio-ref:从视频抽出的音轨,抽完自动导入资产库并绑定)',
  piece: '拼接件(图片拼接 · 多值端口,按源节点画布位置排序)',
  'piece-N': '取拆分产物第 N 片(piece-1/piece-2/…,替代 input/piece 端口)',
  clip: '视频/静帧入轨(时间线)',
  sequence: '镜头编排序列入轨',
  'audio-track': '音轨随片导出',
  'slot-<名称>': '工作流入口槽位注入',
  output: '产物汇聚收口(工作流出口)',
};

/** 单值端口:同一目标节点上该端口至多一条入边(多值端口:ref-image/prompt/clip/sequence/output/slot-*)
 *  `input-video`(video-upscale / frame-grab 的视频输入)语义上就是单值 —— 一个节点只能增强/取帧一路视频。 */
export const SINGLE_VALUE_PORTS = new Set(['first-frame', 'last-frame', 'input', 'input-video', 'ref-audio', 'ref-video']);

/**
 * **未实现节点的 kind —— 入口已下架(2026-10-08)**。
 *
 * 判定标准是「有没有执行分支」,不是「类型定义里有没有这个 kind」:
 * 这三类在渲染层 `CanvasPage.runNode` 里**没有任何分支**,建出来只能得到
 * 「连得起来、点运行没反应」的假入口(真实事故面:节点面板里那个
 * 「ComfyUI 工作流 · 导入 workflow_api.json」其实 kind 是 `director`,
 * 点了只会弹一个导演 prompt 输入框)。
 *
 * - `director`:只存一个 prompt,`domain.ts` 的注释本身就写着「占位」;
 * - `workflow-input` / `workflow-output`:槽位与产物汇聚的**派生态**都在,
 *   但没有「运行整个工作流」的实现(无 RunSnapshot、无收口动作),
 *   槽位填了值也没有消费方。
 *
 * 这是**创建侧的唯一事实源**:渲染层的节点面板/「+」弹层按它过滤,
 * 主进程 `canvas.create_node` 按它直接拒绝(Agent 尤其容易凭
 * `NODE_KIND_GUIDE` 里的旧条目把空壳节点重新建出来)。
 *
 * 定义仍然保留在 `NodeKind` 里 —— 老项目文件里的这些节点要能照常打开、
 * 照常渲染、照常显示在检查器里,下架的只是**新建入口**。
 *
 * ⚠️ 恢复入口的前置条件是**先补上 runNode 执行分支**,不是把名字从本表删掉。
 */
export const HIDDEN_NODE_KINDS: readonly string[] = ['director', 'workflow-input', 'workflow-output'];

/** 该 kind 是否已下架(不可新建) */
export function isHiddenNodeKind(kind: string | undefined): boolean {
  return !!kind && HIDDEN_NODE_KINDS.includes(kind);
}

/** 下架原因(给拒绝创建时的可执行提示用;按 kind 一句话说清「为什么不能建」) */
export const HIDDEN_NODE_REASONS: Record<string, string> = {
  director: '导演台尚未实现(只存 prompt,没有生成运镜小样的执行分支)',
  'workflow-input': '工作流入口尚未实现(没有「运行整个工作流」的能力,槽位填了值也没有消费方)',
  'workflow-output': '工作流出口尚未实现(产物汇聚的收口动作没有执行分支)',
};

/** 人读的连接器能力摘要(给 Agent system prompt / 工具返回) */
export function connectorSummary(): string {
  const lines: string[] = [];
  const outRows = ['shot', 'audio-ref', 'image-gen', 'image-edit', 'image-upscale', 'video-upscale', 'asset'];
  for (const [src, targets] of Object.entries(CONNECTOR_MAP)) {
    // 已下架的 kind 不进 Agent 的能力说明 —— 列出来等于在鼓励模型去用它们,
    // 而 canvas.create_node 又会拒绝,白烧一轮往返(见 HIDDEN_NODE_KINDS)。
    if (HIDDEN_NODE_KINDS.includes(src)) continue;
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
  ['image-gen', '图片生成(mlxgen 文生图;连 ref-image = 参考编辑,缺省 Qwen-Image-2.1 的 qwen21.edit(1-10 张)。要「首图定构图」的多参考生成须节点显式选 AbstractFramework/flux.2-klein-9b-8bit;z-image-turbo 不支持参考图)'],
  ['image-edit', '图片编辑(指令/I2I/Inpaint/Outpaint)'],
  ['image-crop', '图片裁切(按目标画幅裁剪,如 1:1 → 9:16,供下游作输入图)'],
  ['image-stitch', '图片拼接(纯 ffmpeg:多张图横排/竖排/网格拼成一张;piece 多值入边,按源节点画布位置排序)'],
  ['image-split', '图片拆分(纯 ffmpeg:一张图等分多片,长图切片/九宫格;下游经 piece-N 端口按序号取片)'],
  ['image-upscale', '图片增强(超分)'],
  ['frame-grab', '视频裁切取帧(纯 ffmpeg,不推理:从视频截取一帧导出为**图片资源**并自动导入资产库)。这是「视频 → 图片」的唯一合法通道——图片编辑/增强的 input 端口要的是静帧,视频**不能**直连图片编辑(会被校验拒绝)。输入连 shot 成片 / video-upscale 产物 / 视频 asset(input-video 端口,单值);参数 data={mode:first|last|at, seconds}(at 需非负秒数);产物 PNG 可再连给 image-edit / image-upscale 的 input 或 shot 的 first-frame/ref-image'],
  ['video-upscale', '视频增强(超分 + 合修脸):本地后处理,不走推理队列。三阶段可独立开关——去块(ffmpeg deblock)/ 超分(Real-ESRGAN,真人用 realesrgan-x4plus)/ 修脸(GFPGAN 或 CodeFormer)。输入连 shot 成片或视频 asset(input 端口),产物 mp4 接时间线入轨或作下游镜头参考。参数:data={scale, srModel, faceModel, faceWeight, deblock, device}'],
  ['shot', '视频镜头(h3.c:文生/首帧/尾帧/首尾帧/参考图/参考视频;参考视频端口 ref-video 可接视频 asset、上游镜头成片、视频增强产物,默认连同源片音轨一起参考(节点 data.refVideoSilent=true 改走 --ref-silent-video 只取画面);支持 🚀 加速 LoRA:data.accel={enabled,packId,steps},packId 经 accel.list 查蒸馏包并沿用其 steps,开启后提交自动用蒸馏包+少步数)'],
  ['timeline', '时间线/剪辑(FFmpeg 导出;导出成片后自身也是**视频产物源**:可连 frame-grab 取帧 / video-upscale 再增强 / shot 的 ref-video·ref-audio / audio-ref 抽音轨 / 另一条 timeline 入轨,下游从 data.resultPath 读成片)'],
  ['audio-ref', '音频参考(--ref-audio):把音频资产作 shot 的音轨参考,产物带声直出'],
] as const;

export function nodeKindGuide(): string {
  return NODE_KIND_GUIDE.map(([k, d]) => `- ${k}:${d}`).join('\n');
}

