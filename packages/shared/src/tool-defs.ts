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
    { name: 'canvas.list_nodes', description: '列出当前画布的所有节点', parameters: O({}) },
    { name: 'canvas.create_node', description: '在画布上创建节点', parameters: O({ kind: S('document/asset/image-gen/image-edit/shot/director/timeline/audio-ref'), label: S('节点标题'), data: { type: 'object', description: '节点业务数据' }, x: { type: 'number' }, y: { type: 'number' } }, ['kind', 'label']) },
    { name: 'canvas.update_node', description: '更新节点标题或参数', parameters: O({ nodeId: S('节点 id'), label: S('新标题'), data: { type: 'object', description: '要合并进 data 的字段' } }, ['nodeId']) },
    { name: 'canvas.delete_node', description: '删除节点及其连线', parameters: O({ nodeId: S('节点 id') }, ['nodeId']) },
    { name: 'canvas.connect', description: '连接两个节点(from → to)', parameters: O({ from: S('源节点 id'), to: S('目标节点 id'), label: S('连线语义标签') }, ['from', 'to']) },
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