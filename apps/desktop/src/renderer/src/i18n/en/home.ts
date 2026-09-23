/** 页面字典(以中文原文为 key,缺译回退中文) */
export default {
  /* 侧栏导航 */
  '创作': 'Create',
  '资源': 'Resources',
  '系统': 'System',
  '画布工作台': 'Canvas Workbench',
  '资产中心': 'Asset Center',
  'Skills 库': 'Skills Library',
  '引擎引导向导': 'Engine Setup Wizard',
  '返回原型总览': 'Back to Overview',
  /* 引擎状态卡 */
  '引擎状态': 'Engine Status',
  '视频槽位 · h3.c': 'Video Slot · h3.c',
  '图片槽位 · mlxgen': 'Image Slot · mlxgen',
  /* 需求输入区 */
  '本地优先 · 全部数据留在本机': 'Local-first · All data stays on this machine',
  '今天想创作什么？': 'What would you like to create today?',
  '一句话描述你的视频 / 图片需求，例如：「帮我在导演台搭一场戏：男女主在草原上走，遇到一条很宽的河……」':
    "Describe your video / image idea in one sentence, e.g. \"Set up a scene on the director's canvas: the leads walking across the grassland, meeting a wide river…\"",
  '参考图 / 文件': 'Reference / Files',
  '移除附件': 'Remove attachment',
  '角色锁定': 'Character Lock',
  '运镜参考': 'Camera Reference',
  '云端模型 · 需先在设置中配置凭据': 'Cloud Models · Configure credentials in Settings first',
  '规划 Agent · 本地 LLM': 'Planning Agent · Local LLM',
  '生成': 'Generate',
  /* 模型与技能选择 */
  'Ornith-1.5-35B · 本地': 'Ornith-1.5-35B · Local',
  'Ornith-1.5-9B · 本地': 'Ornith-1.5-9B · Local',
  'Ornith-1.5-35B-A3B · 本地': 'Ornith-1.5-35B-A3B · Local',
  '无技能': 'No Skill',
  '无技能 · 自由编排': 'No Skill · Freeform',
  '纸拼贴剧情片': 'Paper Collage Drama',
  '剧情短片': 'Short Drama',
  '电商产品': 'E-commerce Product',
  '科普讲解': 'Science Explainer',
  '水墨': 'Ink Wash',
  '纸拼贴': 'Paper Collage',
  /* 快捷技能模板 */
  '从 Skill 模板开始': 'Start from a Skill Template',
  '用三幕结构写一部 45 秒剧情短片：主角在旧车站错过一班列车，却在站台重逢多年未见的朋友。':
    'Write a 45-second short drama in three acts: the protagonist misses a train at an old station, but reunites with a long-lost friend on the platform.',
  '为保温杯生成 3 个视角的产品视频：侧视旋转、开盖特写、户外使用场景，统一浅灰背景。':
    'Generate product videos of a thermos from 3 angles: side rotation, lid-opening close-up, and outdoor use, all on a light gray background.',
  '做一支 60 秒科普短片解释日全食：从月球轨道切入，到贝利珠瞬间，图文穿插。':
    "Make a 60-second science short explaining a total solar eclipse: from the lunar orbit to the Baily's beads moment, intercut with graphics.",
  '水墨风格山水短片：远山、孤舟、留白，镜头缓慢横移，30 秒。':
    'An ink-wash style landscape short: distant mountains, a lone boat, negative space, slow lateral camera move, 30 seconds.',
  '帮我在导演台搭一场戏：男女主在草原上走，遇到一条很宽的河，女主跃过河，男主在岸边踱步。纸拼贴风格，60 秒以内。':
    "Set up a scene on the director's canvas: the leads walk across the grassland and reach a wide river; she leaps across while he paces the shore. Paper collage style, under 60 seconds.",
  /* 备选入口 */
  '也可以这样开始': 'You Can Also Start Like This',
  '图片 → 视频管线': 'Image → Video Pipeline',
  'Z-Image 静帧作首帧': 'Z-Image stills as first frame',
  '批量产品视频': 'Batch Product Videos',
  '多角度图逐镜生成': 'Multi-angle images, generated shot by shot',
  '导入 H3Mise 项目': 'Import H3Mise Project',
  'M3 · 迁移既有数据': 'M3 · Migrate existing data',
  /* 右侧项目流 */
  '项目流': 'Project Stream',
  '全部项目': 'All Projects',
  '进行中': 'In Progress',
  '最近项目': 'Recent Projects',
  '暂无项目，点「生成」开始': 'No projects yet — click "Generate" to start',
  '创建于 {date}': 'Created {date}',
  '{name}封面': '{name} cover',
  '从 H3Mise 导入项目…': 'Import Project from H3Mise…',
  /* live-card 三态 */
  '渲染任务': 'Render Task',
  '生成中…': 'Generating…',
  '演示': 'Demo',
  '任务排队中': 'Tasks Queued',
  '排队 #{n}': 'Queued #{n}',
  '{n} 个任务等待 · FIFO 串行': '{n} task(s) waiting · FIFO serial',
  '队列空闲': 'Queue Idle',
  '空闲': 'Idle',
  '暂无进行中任务 · 点此进入画布': 'No active tasks · Click to enter the canvas',
  /* 项目操作与新建弹窗 */
  '新建项目': 'New Project',
  '重命名项目': 'Rename Project',
  '重命名': 'Rename',
  '删除项目': 'Delete Project',
  '确定删除项目「{name}」吗?此操作不可恢复。': 'Delete project "{name}"? This cannot be undone.',
  '未命名项目 {n}': 'Untitled Project {n}',
  '为你的创作单独建一个画布与资产空间，数据全部留在本机。':
    'A dedicated canvas and asset space for your work — all data stays on this machine.',
  '项目名称，如：草原之河 · 短剧': 'Project name, e.g. River on the Prairie · Short Drama',
  '创建项目': 'Create Project',
} satisfies Record<string, string>;
