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
    { name: 'canvas.list_nodes', description: '列出当前画布的所有节点(仅 id/类型/标题,不含内容;读内容用 canvas.get_node)', parameters: O({}) },
    { name: 'canvas.get_node', description: '读取单个节点详情:类型/标题/业务数据(含 document 的 markdown、storyboard 的分镜表、shot 的提示词/参数)与它的入/出边', parameters: O({ nodeId: S('节点 id') }, ['nodeId']) },
    { name: 'canvas.create_node', description: '在画布上创建节点。kind 可选:document/storyboard/asset/image-gen/image-edit/image-upscale/shot/director/timeline/audio-ref/workflow-input/workflow-output;storyboard 的 data.markdown 可传一张分镜表', parameters: O({ kind: S('document/storyboard/asset/image-gen/image-edit/image-upscale/shot/director/timeline/audio-ref/workflow-input/workflow-output'), label: S('节点标题'), data: { type: 'object', description: '节点业务数据(如 { markdown } / { prompt, width, height })' }, x: { type: 'number' }, y: { type: 'number' } }, ['kind', 'label']) },
    { name: 'canvas.update_node', description: '更新节点标题或参数(data 合并进现有字段;改 document/storyboard 的 markdown 会重排下游连线语义)', parameters: O({ nodeId: S('节点 id'), label: S('新标题'), data: { type: 'object', description: '要合并进 data 的字段' } }, ['nodeId']) },
    { name: 'canvas.delete_node', description: '删除节点及其连线', parameters: O({ nodeId: S('节点 id') }, ['nodeId']) },
    { name: 'canvas.connect', description: '连接两个节点(from → to)。label 必须用目标端口语义:prompt=提示词注入(文档/分镜表→生成节点)、first-frame=首帧直通、ref-image=参考图、ref-audio=音轨参考、input=输入图/帧、clip/sequence=入轨、slot-<名称>=工作流槽位、output=收口。不确定时先查 canvas.connectors', parameters: O({ from: S('源节点 id'), to: S('目标节点 id'), label: S('连线语义标签(端口)') }, ['from', 'to']) },
    { name: 'canvas.connectors', description: '查询连接器能力:哪些节点类型可互相连线、各端口(label)语义含义。建/改连线前建议先查', parameters: O({}) },
    { name: 'ask.user', description: '向用户提问并等待选择(需要用户决策时用,如确认铺节点/选档位/选方案/确认执行)。这是唯一的提问通道:禁止用普通文本写问句/确认,一律调用本工具。options 给 2~6 个候选答案;调用后本轮对话暂停,用户点选后你会收到选择结果继续', parameters: O({ question: S('问题(支持 Markdown,可含 GFM 表格做方案对比)'), options: { type: 'array', items: { anyOf: [{ type: 'string' }, O({ label: S('选项主文案'), sub: S('可选:灰色补充说明行'), recommended: { type: 'boolean', description: '可选:true=显示「推荐」徽标(至多一个)' } }, ['label'])] }, description: '2~6 个选项;字符串,或 {label, sub?, recommended?} 对象(需要补充说明/推荐标记时用对象)' } }, ['question', 'options']) },
    { name: 'storyboard.plan', description: '从文档/文本生成分镜表并落画布(Agent 规划;默认分步只出表,可在检查器改表后铺节点;autoMaterialize=true 时同时按行铺出 shot/image-gen)。sourceNodeId 或 brief 二选一', parameters: O({ nodeId: S('document 节点 id(从该节点 markdown 读需求;也可省略直接给 brief)'), brief: S('直接给需求/小说文本(与 nodeId 二选一)'), basePrompt: S('可选:全局质感段,铺节点时注入每行'), autoMaterialize: { type: 'boolean', description: '可选:true=出表后立即按行铺节点,缺省 false(分步)' } }) },
    { name: 'storyboard.materialize', description: '从分镜表节点按行铺出生成节点:每行建一个 shot(提示词按 H3 五段式组装),「需配图=是」的行再建 image-gen(Z-Image 六段式)并连 first-frame 直通;只创建节点不触发运行。已铺过的行跳过(追加铺)', parameters: O({ nodeId: S('分镜表(storyboard)节点 id'), aspect: S('可选:16:9 / 9:16 / 1:1,缺省用节点设置'), tier: S('可选:preview / default,缺省用节点设置') }, ['nodeId']) },
    { name: 'engine.submit', description: '提交节点到引擎生成(视频/图片)', parameters: O({ nodeId: S('节点 id') }, ['nodeId']) },
    { name: 'engine.queue_status', description: '查询渲染队列状态', parameters: O({}) },
    { name: 'engine.cancel', description: '取消队列任务', parameters: O({ jobId: S('任务 id') }, ['jobId']) },
    { name: 'assets.list', description: '列出资产库', parameters: O({}) },
    { name: 'assets.get', description: '读取单个资产详情', parameters: O({ assetId: S('资产 id') }, ['assetId']) },
    { name: 'assets.import', description: '导入资产到资产库(图片/视频/音频/文档)。两种方式:①传 paths(绝对路径数组,headless 自动导入)②传 openDialog=true 弹系统对话框让用户选。最大单文件 2GB。', parameters: O({
      paths: { type: 'array', items: { type: 'string' }, description: '绝对路径列表' },
      openDialog: { type: 'boolean', description: '是否弹出系统文件选择对话框' },
    }) },
    { name: 'skills.list', description: '列出 Skills 库', parameters: O({}) },
    { name: 'skills.apply', description: '应用 Skill 到新项目', parameters: O({ skillId: S('Skill id'), projectName: S('新项目名') }, ['skillId']) },
    { name: 'skills.save', description: '把当前画布保存为 Skill 模板', parameters: O({ name: S('Skill 名称') }, ['name']) },
    { name: 'timeline.export', description: '导出时间线(合成当前画布已生成的镜头)', parameters: O({ outputName: S('输出文件名') }) },
    { name: 'memory.update_core', description: '更新核心记忆(projectGoal/styleGuide/constraints/userPreferences)', parameters: O({ section: S('记忆段名'), content: S('内容') }, ['section', 'content']) },
    { name: 'memory.remember', description: '把事实记入项目长期记忆', parameters: O({ text: S('要记住的内容'), tags: { type: 'array', items: { type: 'string' } } }, ['text']) },
    { name: 'memory.recall_search', description: '检索项目记忆', parameters: O({ query: S('检索词') }, ['query']) },
    { name: 'continuity.check', description: '校验相邻镜头的连续性(尾帧/首帧)', parameters: O({}) },
  ];
}