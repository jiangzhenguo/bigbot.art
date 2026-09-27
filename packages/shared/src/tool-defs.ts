/**
 * 工具定义 — Agent 可调用的工具 schema(pi-ai Tool[] 格式,纯 JSON Schema)
 * worker 用这份定义告诉 LLM 有哪些工具;主进程 tool-handlers.ts 负责执行。
 * 注意:本文件在 agent 包内,不能引用 apps/desktop 的主进程模块。
 */

const S = (d: string) => ({ type: 'string' as const, description: d });
const O = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: props,
  required,
});

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toolDefinitions(): ToolDef[] {
  return [
    { name: 'canvas.list_nodes', description: '列出当前画布的所有节点(每行:「标题」 [类型] (尺寸,asset=资产元数据宽高,image-gen/shot 等=data.width×data.height) (id=…);对用户回复时用标题称呼节点,id 仅供工具参数;完整内容用 canvas.get_node)', parameters: O({}) },
    { name: 'canvas.get_node', description: '读取单个节点详情:标题/类型/业务数据(含 document 的 markdown、storyboard 的分镜表、shot 的提示词/参数)与它的入/出边(对端节点以标题展示)', parameters: O({ nodeId: S('节点 id(canvas.list_nodes 返回行尾的 id=…)') }, ['nodeId']) },
    { name: 'canvas.create_node', description: '在画布上创建节点。kind 可选:document/storyboard/asset/image-gen/image-edit/image-upscale/image-crop/image-stitch/image-split/video-upscale/shot/director/timeline/audio-ref/workflow-input/workflow-output;storyboard 的 data.markdown 可传一张分镜表。⚠️ 大任务请分步:一次对话只创建 1~2 个节点(可搭配 canvas.connect 分批连线),把大计划拆成多轮执行——单轮输出过长会被模型输出上限截断导致「空回复」', parameters: O({ kind: S('document/storyboard/asset/image-gen/image-edit/image-upscale/image-crop/image-stitch/image-split/video-upscale/shot/director/timeline/audio-ref/workflow-input/workflow-output'), label: S('节点标题'), data: { type: 'object', description: '节点业务数据(如 { markdown } / { prompt, width, height, accel } / image-crop { aspect, focus } / image-stitch { mode:row|column|grid, gridCols, gap, bg } / image-split { mode:rows|cols|grid, count, gridCols, gridRows } / video-upscale { scale, srModel, faceModel, faceWeight, deblock, device });创建 shot 前先 canvas.list_nodes 看前置图片节点并沿用其 width×height;要加速可先 accel.list 查蒸馏包,再设 data.accel={enabled:true, packId, steps}' }, x: { type: 'number' }, y: { type: 'number' } }, ['kind', 'label']) },
    { name: 'canvas.update_node', description: '更新节点标题或参数(data 合并进现有字段;改 document/storyboard 的 markdown 会重排下游连线语义;给 shot 开加速 LoRA 可传 data:{accel:{enabled:true,packId,steps}})。⚠️ 不接受 data.refs:shot 的参考引用一律由连线(canvas.connect)推导,直写 refs 会被忽略', parameters: O({ nodeId: S('节点 id'), label: S('新标题'), data: { type: 'object', description: '要合并进 data 的字段(如 prompt/width/height/accel 等);refs 字段会被忽略,请用 canvas.connect 管理参考' } }, ['nodeId']) },
    { name: 'canvas.delete_node', description: '删除节点及其连线', parameters: O({ nodeId: S('节点 id') }, ['nodeId']) },
    { name: 'canvas.connect', description: '连接两个节点(from → to),写边前会强制校验端口:label 必须合法(按源/目标类型与媒体限定)、单值端口(first-frame/last-frame/input/ref-audio/ref-video)同一目标只有一条入边——重复连会**自动替换**旧边(旧来源生效时标记 stale)。label 用目标端口语义:prompt=提示词注入、first-frame=首帧直通、ref-image=参考图(可多张)、ref-audio=音轨、ref-video=参考视频、input=输入图/帧、clip/sequence=入轨、slot-<名称>=工作流槽位、output=收口。不确定先查 canvas.connectors;连错会得到带可用端口说明的报错', parameters: O({ from: S('源节点 id'), to: S('目标节点 id'), label: S('连线语义标签(端口)') }, ['from', 'to']) },
    { name: 'canvas.disconnect', description: '删除一条连线(from → to,可按 label 精确匹配)。用于:撤销错误的连接、把单值端口让位给新来源(先断旧边再 canvas.connect)、清理冗余引用。若删除的是单值端口入边,下游节点可能因缺参考而失效(提交时会有提示)', parameters: O({ from: S('源节点 id'), to: S('目标节点 id'), label: S('可选:连线语义标签;省略则删除 from→to 的全部连线') }, ['from', 'to']) },
    { name: 'canvas.connectors', description: '查询连接器能力:哪些节点类型可互相连线、各端口(label)语义含义。建/改连线前建议先查', parameters: O({}) },
    { name: 'document.read', description: '分段读取画布文档节点(document/storyboard)的全文:先读 chunk=0 看结构与总块数,再按需递增 chunk 逐段读取(长文档不会一次性全量返回,避免截断)。适合长剧本/需求/分镜表逐段分析', parameters: O({ nodeId: S('document / storyboard 节点 id'), chunk: { type: 'number', description: '块序号(0 起,默认 0;chunk=N 返回该段,行号连续)' }, size: { type: 'number', description: '可选:覆盖默认块大小(字符,默认 4000)' } }, ['nodeId']) },
    { name: 'ask.user', description: '向用户提问并等待选择(需要用户决策时用,如确认铺节点/选档位/选方案/确认执行)。这是唯一的提问通道:禁止用普通文本写问句/确认,一律调用本工具。options 给 2~6 个候选答案;调用后本轮对话暂停,用户点选后你会收到选择结果继续', parameters: O({ question: S('问题(支持 Markdown,可含 GFM 表格做方案对比)'), options: { type: 'array', items: { anyOf: [{ type: 'string' }, O({ label: S('选项主文案'), sub: S('可选:灰色补充说明行'), recommended: { type: 'boolean', description: '可选:true=显示「推荐」徽标(至多一个)' } }, ['label'])] }, description: '2~6 个选项;字符串,或 {label, sub?, recommended?} 对象(需要补充说明/推荐标记时用对象)' } }, ['question', 'options']) },
    { name: 'storyboard.plan', description: '从文档/文本生成分镜表并落画布(Agent 规划;默认分步只出表,可在检查器改表后铺节点;autoMaterialize=true 时同时按行铺出 shot/image-gen)。sourceNodeId 或 brief 二选一', parameters: O({ nodeId: S('document 节点 id(从该节点 markdown 读需求;也可省略直接给 brief)'), brief: S('直接给需求/小说文本(与 nodeId 二选一)'), basePrompt: S('可选:全局质感段,铺节点时注入每行'), autoMaterialize: { type: 'boolean', description: '可选:true=出表后立即按行铺节点,缺省 false(分步)' } }) },
    { name: 'storyboard.materialize', description: '从分镜表节点按行铺出生成节点:每行建一个 shot(提示词按 H3 五段式组装),「需配图=是」的行再建 image-gen(Z-Image 六段式)并连 first-frame 直通;只创建节点不触发运行。已铺过的行跳过(追加铺)', parameters: O({ nodeId: S('分镜表(storyboard)节点 id'), aspect: S('可选:16:9 / 9:16 / 1:1,缺省用节点设置'), tier: S('可选:preview / default,缺省用节点设置') }, ['nodeId']) },
    { name: 'engine.submit', description: '提交节点到引擎生成(视频/图片);image-gen 的 ref-image 连线会作为参考图传入(多参考生成需 flux.2-klein 模型,其它模型带参考图会报错提示换模型);image-crop / image-stitch / image-split / video-upscale 四种本地节点也走这里:前三种 ffmpeg 秒级同步完成;video-upscale(超分 + 合修脸)是**长任务**(每帧 1.2-1.5s,5s 片约 3-4 分钟),同步阻塞直到出片;输入由连线自动解析(input/piece-N 单值入边、piece 多值入边按源节点画布位置排序);shot 若 data.accel.enabled 会自动用蒸馏模型包 + 少步数(4/8 步),包不可用会报错。⚠️ 返回「已提交」= 已进队列,本工具调用后**立即结束本轮并告知用户**(生成是分钟级后台任务,完工会自动刷新);禁止提交后用 engine.queue_status 轮询等待——等不到结果且会烧光轮数', parameters: O({ nodeId: S('节点 id') }, ['nodeId']) },
    { name: 'frames.extract', description: '从视频里抽一帧存成图片**资源节点**(ffmpeg 秒级同步完成):抽首帧/尾帧/指定时间点,自动把 PNG 导入资产库并在画布上新建一个 asset 节点,返回的 nodeId 可直接 canvas.connect 连给下游(如连到 image-edit 的 input 端口做「取帧再编辑」、连到 shot 的 first-frame 做首帧)。视频来源二选一:nodeId(画布上有产物的镜头/视频节点)或 videoPath(产物/资产/导出目录下的绝对路径)', parameters: O({ nodeId: S('视频来源:画布节点 id(镜头 shot 或其他有视频产物的节点);与 videoPath 二选一'), videoPath: S('视频来源:绝对路径(仅限产物/资产/导出目录);与 nodeId 二选一'), at: S('取帧位置:first=首帧(默认)/ last=尾帧 / 指定时间点填秒数(如 3.5)'), label: S('可选:新建资源节点的标题(缺省「<来源名> · 首帧/尾帧/第 Ns 帧」)'), x: { type: 'number', description: '可选:新节点画布坐标 x' }, y: { type: 'number', description: '可选:新节点画布坐标 y' } }) },
    { name: 'accel.list', description: '列出已安装的加速 LoRA 蒸馏模型包(packId/名称/推荐步数/是否默认/目录是否有效),用于给 shot 节点开启加速', parameters: O({}) },
    { name: 'engine.queue_status', description: '查询渲染队列状态(整体队列概况:排队中/运行中/已完成数量)。⚠️ 非必要不查:engine.submit 返回「已提交」即已入队,生成是分钟级后台任务,提交后轮询本工具**等不到结果**只会烧光工具轮数——正确做法是提交后直接结束本轮,完工会自动刷新画布;仅当用户明确要求查看进度时才调用,且一次即可', parameters: O({}) },
    { name: 'engine.cancel', description: '取消队列任务', parameters: O({ jobId: S('任务 id') }, ['jobId']) },
    { name: 'assets.list', description: '列出资产库', parameters: O({}) },
    { name: 'assets.get', description: '读取单个资产详情', parameters: O({ assetId: S('资产 id') }, ['assetId']) },
    { name: 'assets.import', description: '导入资产到资产库(图片/视频/音频/文档)。两种方式:①传 paths(绝对路径数组,headless 自动导入)②传 openDialog=true 弹系统对话框让用户选。最大单文件 2GB。', parameters: O({
      paths: { type: 'array', items: { type: 'string' }, description: '绝对路径列表' },
      openDialog: { type: 'boolean', description: '是否弹出系统文件选择对话框' },
    }) },
    { name: 'skills.list', description: '列出 Skills 库(含是否携带 Agent 操作指令段 instructions)', parameters: O({}) },
    { name: 'skills.read', description: '读取单个技能的完整 Agent 操作指令(instructions:Markdown 操作手册/提示词)。适合:激活 summary 模式的技能时按需取全文;或想复用某技能的指令前先读。无指令的技能返回「仅画布模板」', parameters: O({ skillId: S('Skill id') }, ['skillId']) },
    { name: 'skills.activate', description: '把技能设为当前画布激活(对话自动加载其操作指令,后续按技能工作)。同一画布至多一个激活技能,重复激活 = 替换;返回注入预览(前 N 字符),可用 skills.deactivate 停用', parameters: O({ skillId: S('Skill id') }, ['skillId']) },
    { name: 'skills.deactivate', description: '停用当前画布激活的技能(清除 activeSkillId,不再注入指令)', parameters: O({}) },
    { name: 'skills.apply', description: '应用 Skill 到新项目(克隆节点换新 id 实体化);activate=true 时同时在新项目主画布上激活该技能(铺结构 + 载入操作指令)', parameters: O({ skillId: S('Skill id'), projectName: S('新项目名'), activate: { type: 'boolean', description: '可选:true=应用后同时在新项目主画布激活该技能(默认 false)' } }, ['skillId']) },
    { name: 'skills.save', description: '把当前画布保存为 Skill 模板;instructions 可选:把「当前对话强调的操作要求」沉淀为技能指令段(对话自动加载),inject=summary 时上下文只放摘要、用 skills.read 取全文', parameters: O({ name: S('Skill 名称'), instructions: S('可选:Agent 操作指令段(Markdown 操作手册/提示词模板,支持 {占位} 参数)'), inject: S('可选:full=全量注入(默认)/ summary=上下文只放摘要,按需 skills.read') }, ['name']) },
    { name: 'timeline.export', description: '导出时间线(合成当前画布已生成的镜头)', parameters: O({ outputName: S('输出文件名') }) },
    { name: 'memory.update_core', description: '更新核心记忆(projectGoal/styleGuide/constraints/userPreferences)', parameters: O({ section: S('记忆段名'), content: S('内容') }, ['section', 'content']) },
    { name: 'memory.remember', description: '把事实记入项目长期记忆', parameters: O({ text: S('要记住的内容'), tags: { type: 'array', items: { type: 'string' } } }, ['text']) },
    { name: 'memory.recall_search', description: '检索项目记忆', parameters: O({ query: S('检索词') }, ['query']) },
    { name: 'continuity.check', description: '校验相邻镜头的连续性(尾帧/首帧)', parameters: O({}) },
  ];
}