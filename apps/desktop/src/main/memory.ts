/**
 * MemoryStore — Agent 分层记忆(MemGPT 式)
 * 持久化 ~/.bigbotart/workspaces/<projectId>/memory.json(2026-09-29 起按工作空间收敛;
 * 旧路径 memory-<projectId>.json 由 migrate.ts 启动时搬迁)
 *
 * 四层:
 * - core: 核心记忆(项目目标/风格/约束/偏好),始终全量注入 system prompt
 * - canvasMemory: 每个画布的总结(切换画布时写入;其他画布以 summary 注入当前会话)
 * - recall: 全部对话消息(按 canvasId 检索最近 N 条注入)
 * - archival: 长期事实(生成产物/关键决定),关键字检索注入
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectMemory, RecallMessage, ArchivalEntry, CanvasNode, CanvasEdge } from '@bigbotart/shared';
import { nodeKindGuide, connectorSummary } from '@bigbotart/shared';
import { DATA_DIR, memoryFile } from './workspace-paths.js';

const RECALL_INJECT_LIMIT = 12; // 当前画布最近 N 条可注入消息(user/assistant/system;tool 留痕记录不占窗口)
const ARCHIVAL_INJECT_LIMIT = 3; // archival 检索 top N
const SUMMARY_FALLBACK_LEN = 200; // summary 生成的保底截断
/** /compact 保留的最近消息条数(压缩更早的 old 部分;尾部保留以承接上下文/待确认 ask 卡) */
export const COMPACT_KEEP_LAST = 8;

/** /compact 的确定性兜底摘要(LLM 不可达/失败时保证压缩流程照常完成,不阻塞用户) */
export function compactFallbackSummary(msgs: RecallMessage[]): string {
  const lines = msgs.map((r) => {
    const who =
      r.role === 'user' ? '用户' : r.role === 'assistant' ? '助手' : r.role === 'system' ? '系统' : `工具(${r.toolName ?? '?'})`;
    return `${who} ${r.content}`.slice(0, 160);
  });
  return `【对话自动摘要 · LLM 不可用时兜底】\n${lines.join('\n')}`.slice(0, 1500);
}

function memFile(projectId: string): string {
  return memoryFile(projectId);
}

function emptyMemory(projectId: string): ProjectMemory {
  return {
    projectId,
    core: { projectGoal: '', styleGuide: '', constraints: '', userPreferences: '' },
    canvasMemory: {},
    recall: [],
    archival: [],
  };
}

export class MemoryStore {
  private cache = new Map<string, ProjectMemory>();

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  get(projectId: string): ProjectMemory {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const f = memFile(projectId);
    if (existsSync(f)) {
      try {
        const m = JSON.parse(readFileSync(f, 'utf-8')) as ProjectMemory;
        this.cache.set(projectId, m);
        return m;
      } catch {
        /* 损坏则重建 */
      }
    }
    const m = emptyMemory(projectId);
    this.cache.set(projectId, m);
    return m;
  }

  /**
   * 整体写入某项目的记忆(项目包导入专用)。
   *
   * `projectId` 以入参为准强制覆盖:包里的记忆来自导出端项目 id,直接落盘会写进
   * **原项目的工作空间**,把导入端既有项目的记忆覆盖掉(跨机时则是写进一个不存在的 pid)。
   * 调用方已按新画布 id 重映射过 canvasMemory/recall.canvasId,这里只兜 projectId 这一层。
   */
  replace(projectId: string, memory: ProjectMemory): void {
    this.cache.set(projectId, { ...memory, projectId });
    this.persist(projectId);
  }

  private persist(projectId: string): void {
    const m = this.cache.get(projectId);
    if (m) {
      const f = memFile(projectId);
      mkdirSync(dirname(f), { recursive: true }); // 工作空间子目录可能尚未建立
      writeFileSync(f, JSON.stringify(m, null, 2));
    }
  }

  /** 追加对话消息到 recall */
  addRecall(projectId: string, msg: Omit<RecallMessage, 'id' | 'createdAt'>): RecallMessage {
    const m = this.get(projectId);
    const entry: RecallMessage = {
      ...msg,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    };
    m.recall.push(entry);
    this.persist(projectId);
    return entry;
  }

  /** 写归档记忆 */
  addArchival(projectId: string, text: string, tags: string[], sourceCanvasId?: string): ArchivalEntry {
    const m = this.get(projectId);
    const entry: ArchivalEntry = {
      id: `arc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      tags,
      sourceCanvasId,
      createdAt: new Date().toISOString(),
    };
    m.archival.push(entry);
    this.persist(projectId);
    return entry;
  }

  /** 更新核心记忆某段 */
  updateCore(projectId: string, section: keyof ProjectMemory['core'], content: string): void {
    const m = this.get(projectId);
    m.core[section] = content;
    this.persist(projectId);
  }

  /** 更新画布总结(切换画布/关键变化时调用) */
  updateCanvasSummary(projectId: string, canvasId: string, summary: string, nodeCount: number, keyDecision?: string): void {
    const m = this.get(projectId);
    const cur = m.canvasMemory[canvasId] ?? {
      summary: '', nodeCount: 0, lastActive: '', keyDecisions: [] as string[],
    };
    cur.summary = summary;
    cur.nodeCount = nodeCount;
    cur.lastActive = new Date().toISOString();
    if (keyDecision) cur.keyDecisions.push(keyDecision);
    m.canvasMemory[canvasId] = cur;
    this.persist(projectId);
  }

  /** /clear:清空当前画布对话——移除该画布全部 recall + 对话压缩摘要(节点总结 summary 保留) */
  clearConversation(projectId: string, canvasId: string): { cleared: number } {
    const m = this.get(projectId);
    const before = m.recall.length;
    m.recall = m.recall.filter((r) => r.canvasId !== canvasId);
    let changed = m.recall.length !== before;
    const cur = m.canvasMemory[canvasId];
    if (cur?.conversationSummary) {
      m.canvasMemory[canvasId] = { ...cur, conversationSummary: undefined };
      changed = true;
    }
    if (changed) this.persist(projectId);
    return { cleared: before - m.recall.length };
  }

  /** /compact:把画布旧对话压成摘要——合并写入 canvasMemory.conversationSummary,裁剪 recall 只留最近 keepLast 条 */
  compactConversation(projectId: string, canvasId: string, summary: string, keepLast = COMPACT_KEEP_LAST): { replaced: number } {
    const m = this.get(projectId);
    const entries = m.recall.filter((r) => r.canvasId === canvasId);
    const replaced = Math.max(0, entries.length - keepLast);
    if (replaced === 0) return { replaced: 0 };
    const cur = m.canvasMemory[canvasId];
    const merged = cur?.conversationSummary ? `${cur.conversationSummary}\n\n${summary}` : summary;
    m.canvasMemory[canvasId] = {
      summary: cur?.summary ?? '',
      nodeCount: cur?.nodeCount ?? 0,
      lastActive: cur?.lastActive ?? new Date().toISOString(),
      keyDecisions: cur?.keyDecisions ?? [],
      conversationSummary: merged,
      activeSkillId: cur?.activeSkillId, // 压缩不改变画布激活技能
    };
    m.recall = m.recall.filter((r) => r.canvasId !== canvasId || entries.indexOf(r) >= entries.length - keepLast);
    this.persist(projectId);
    return { replaced };
  }

  /** 🆕 读画布激活技能 id(无则 undefined) */
  getActiveSkillId(projectId: string, canvasId: string): string | undefined {
    return this.get(projectId).canvasMemory[canvasId]?.activeSkillId;
  }

  /** 🆕 激活/停用画布技能(skillId=null 停用);持久化,跨会话恢复 */
  setActiveSkillId(projectId: string, canvasId: string, skillId: string | null): void {
    const m = this.get(projectId);
    const cur = m.canvasMemory[canvasId];
    if (!cur) {
      if (!skillId) return;
      m.canvasMemory[canvasId] = {
        summary: '', nodeCount: 0, lastActive: new Date().toISOString(), keyDecisions: [],
        activeSkillId: skillId,
      };
    } else {
      m.canvasMemory[canvasId] = { ...cur, activeSkillId: skillId ?? undefined };
    }
    this.persist(projectId);
  }

  /** 检索 recall(当前画布最近 N 条注入消息)。
   *  窗口只数可注入角色(user/assistant/system):role=tool 是留痕回看用的机器记录,不参与计数。
   *  否则一轮「操作前必查」的工具调用(list_nodes + get_node×N,每条占 tool+system 两条)
   *  就能把用户的原始指令挤出窗口 —— 真实事故:「编辑图片让女孩站立」经一轮 ask.user 往返后即掉出上下文。 */
  recentRecall(projectId: string, canvasId: string, limit = RECALL_INJECT_LIMIT): RecallMessage[] {
    const m = this.get(projectId);
    return m.recall
      .filter((r) => r.canvasId === canvasId && (r.role === 'user' || r.role === 'assistant' || r.role === 'system'))
      .slice(-limit);
  }

  /** 当前任务链的首条用户指令:最近一条「非 ask.user 应答」的 user 消息。
   *  ask 应答(点选项/自由回复)的前一条必是 ask.user 的 tool 记录,据此区分「新指令」与「链内应答」。 */
  pinnedInstruction(projectId: string, canvasId: string): string | undefined {
    const entries = this.get(projectId).recall.filter((r) => r.canvasId === canvasId);
    for (let i = entries.length - 1; i >= 0; i--) {
      const r = entries[i];
      if (!r || r.role !== 'user') continue;
      const prev = entries[i - 1];
      if (prev && prev.role === 'tool' && prev.toolName === 'ask.user') continue; // ask 应答,不是新指令
      return r.content;
    }
    return undefined;
  }

  /** archival 关键字检索(简单包含匹配 + 时间倒序) */
  searchArchival(projectId: string, query: string, limit = ARCHIVAL_INJECT_LIMIT): ArchivalEntry[] {
    const m = this.get(projectId);
    const q = query.toLowerCase();
    const hits = m.archival.filter((a) =>
      a.text.toLowerCase().includes(q) || a.tags.some((t) => q.includes(t.toLowerCase())),
    );
    const rest = m.archival.filter((a) => !hits.includes(a));
    return [...hits.reverse(), ...rest.reverse()].slice(0, limit);
  }

  /**
   * 生成「当前画布」实时状态段(注入 system prompt 首轮感知):
   * 节点按 kind 统计 + 标题清单;关键连线(shot 接续链 / 参考图 / 分镜文档 → 生成节点的提示词注入)。
   * 长度受控(节点标题限量、连线限量),避免 prompt 膨胀;完整结构仍以 canvas.list_nodes 为准。
   */
  static canvasStateSummary(
    snap: { name: string; nodes: CanvasNode[]; edges: CanvasEdge[] },
    maxTitlesPerKind = 6,
    maxEdges = 6,
  ): string {
    const counts: Record<string, number> = {};
    const titlesByKind: Record<string, string[]> = {};
    for (const n of snap.nodes) {
      counts[n.kind] = (counts[n.kind] ?? 0) + 1;
      (titlesByKind[n.kind] ??= []).push(n.label || n.id);
    }
    const nodeLines = Object.entries(counts).map(([k, v]) => {
      const titles = (titlesByKind[k] ?? []).slice(0, maxTitlesPerKind).map((t) => `「${t}」`).join('、');
      const total = titlesByKind[k]?.length ?? 0;
      const more = total > maxTitlesPerKind ? ` 等${total}个` : '';
      return `${v}个${k}${titles ? `(${titles}${more})` : ''}`;
    });
    const idToKind = new Map(snap.nodes.map((n) => [n.id, n.kind]));
    const idToLabel = new Map(snap.nodes.map((n) => [n.id, n.label || n.id]));
    // 关键连线:first-frame(镜头接续/首帧直通)、ref-image(参考图)、prompt(分镜表/文档 → 生成节点)
    const keyEdges = snap.edges.filter((e) => {
      const label = e.label ?? '';
      const srcKind = idToKind.get(e.source);
      return (
        label === 'first-frame' ||
        label === 'ref-image' ||
        (label === 'prompt' && (srcKind === 'document' || srcKind === 'storyboard'))
      );
    });
    const edgeLines = keyEdges.slice(0, maxEdges).map((e) => {
      const from = idToLabel.get(e.source) ?? e.source;
      const to = idToLabel.get(e.target) ?? e.target;
      return `- ${from} → ${to}${e.label ? `(${e.label})` : ''}`;
    });
    const edgeHead = edgeLines.length
      ? `关键连线:\n${edgeLines.join('\n')}${snap.edges.length > maxEdges ? `\n…(共 ${snap.edges.length} 条连线,详查 canvas.connectors / canvas.list_nodes)` : ''}`
      : '';
    return (
      `【当前画布】「${snap.name}」· ${snap.nodes.length} 节点 / ${snap.edges.length} 连线\n` +
      `节点:${nodeLines.join('、') || '(空画布)'}${edgeHead ? `\n${edgeHead}` : ''}\n` +
      `提示:需要节点 id 与最新结构时,以 canvas.list_nodes 返回为准;圆点/标题等细节可 canvas.get_node。`
    );
  }

  /**
   * 组装发给 LLM 的上下文:
   * system prompt(core 全量) + 画布激活技能指令 + 其他画布 summary 注入 + 当前画布 recall 最近 N 条 + archival 检索
   * @param resolveSkill 技能解析器(由调用方注入 SkillStore.get,避免 memory 依赖 skills 层;
   *                     激活技能经它取 name/instructions/inject 注入「【当前技能】」段)
   * @param canvas 当前画布快照(选传;由调用方从 store 读,避免 memory 依赖 store;注入「【当前画布】」实时状态段)
   */
  buildContext(
    projectId: string,
    canvasId: string,
    userInput: string,
    resolveSkill?: (skillId: string) => { name: string; instructions?: string; inject?: 'full' | 'summary' } | undefined,
    canvas?: { name: string; nodes: CanvasNode[]; edges: CanvasEdge[] } | undefined,
  ): {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  } {
    const m = this.get(projectId);
    const parts: string[] = [];

    // ① 核心记忆
    parts.push(`你是 BigBotArt 画布工作台里的视频创作 Agent。你可以调用工具操作画布/引擎/资产/Skills。
工具返回后你会收到工具结果,然后继续回复或继续调用工具。
始终用中文回复。回答要具体、可执行,不要空谈。

【提问规则 — ask.user】
⚠️ ask.user 是唯一的提问通道:禁止把问句/确认写成正文文本(如「确认吗?」「是否继续?」)。只要你在等用户做决定,就必须调用 ask.user 工具,正文不要重复问题。
⚠️ 提问要有节制,确认卡太多会卡死对话。只有这两种情况才准提问:
① 用户的指令有多种合理解读,且各路径代价差异大(如「改风格」= 全量重跑 vs 只改提示词):把方案对比列成选项;
② 关键信息缺失且无法合理默认(如必须让用户给提示词、选风格方向)。
以下常规操作一律直接执行,不要确认:创建/更新/连线节点(canvas.create_node / update_node / connect)、出分镜表(storyboard.plan)、按分镜表铺节点(storyboard.materialize)、提交生成(engine.submit)、导出时间线(timeline.export)——它们都可回退或有产物留档;删除节点(canvas.delete_node)由系统确认卡自动兜底,你也不用提前问。
⚠️ 尤其是 storyboard.plan:**不要先问「要不要我出分镜表」,也不要回一句「我开始出分镜表」就结束本轮** —— 这句话之后必须真的跟着 storyboard.plan 工具调用,否则用户看到的就是「说了要做却没动静」(真实事故:模型回「我开始出分镜表」但本轮零工具调用,画布上什么都没产出)。
用户说了「确认/执行/提交/继续」类授权后,立即执行对应工具,禁止二次确认(二次确认会陷入死循环)。
选项写法:能给一句补充说明时,options 用对象形式 {label, sub, recommended},把最稳妥的方案标 recommended=true(至多一个);简单选项直接给字符串即可。

【操作前必查】删除/更新/连线等以节点 id 为参数的操作,必须先调用 canvas.list_nodes 拉取当前画布最新节点列表(历史对话里的节点 id 可能已过期/已删除),再按返回的 id 执行;不允许凭记忆直接操作。

【提交即收尾 — 禁轮询】engine.submit 返回「已提交」就代表任务已进入渲染队列,**这一轮就到此结束**:直接用一句话告诉用户「已提交生成,完成后画布会自动刷新」即可,不要再调用 engine.queue_status / canvas.get_node / canvas.list_nodes 去「看看好了没有」。生成是分钟级后台任务,轮询既等不到结果,还会把工具轮数烧光、让本轮以失败收场(真实事故)。
- 禁止:提交后连续调用 engine.queue_status 查进度;禁止在无新指令时反复 get_node 看节点状态。
- 只有用户**明确要求**「看看进度/排到哪了」时才调用 engine.queue_status,且一次即可,拿到结果就汇报结束。
- 需要一次提交多个节点时,把这些 engine.submit 在同一轮里发完,然后收尾——不要「提交一个 → 查一次 → 再提交下一个」。

### ⚠️ 例外:多步流程里,用户催推进时可以「查一次」(重要,别把自己卡死)

**真实事故(2026-10-09,「测试3」画布)**:Agent 提交了角色卡渲染 → 按上面的规矩收尾 →
**图其实 2 分钟后就出好了**,但用户随后说「继续」时,Agent 回复「提交后等出图,工期内不再主动轮询」,
**零工具调用**。它老老实实守规矩,结果**永远停在「等」的状态**,用户看着就是「又卡住了」。

**规则冲突的根源**:上面的「禁轮询」治的是「**同一轮里反复查**」(会烧光工具轮数)。
而下面这种情况完全不是轮询,却被一起禁掉了:
- **用户在新的一轮里给了推进指令**(「继续」「下一步」「继续建角色」「好了吗」);
- 且你**上一轮刚提交过任务**,而这一步的下一步依赖那个产物是否已就绪。

**此时应当先查一次目标节点**(canvas.get_node 或 canvas.list_nodes),按结果分两路:

1. **已有产物**(data.resultPath 非空)→ **直接推进下一步**,不要再提「等出图」。
2. **仍无产物** → 如实告知「还在渲染中(已提交约 N 分钟)」,并可以提示用户稍等或稍后再催一次。
   **不要凭空承诺「出图后我会自动做 X」** —— 你没有后台唤醒机制,等不到那一刻;
   要么本轮就查,要么明确请用户过一会儿再来催一次。

判据一句话:**「这是用户在催我推进,还是我在同一轮里自己反复刷?」** —— 前者可以查一次,后者禁止。
同一条推进指令**只查一次**,没出就如实说,不要连续重试。


【看图的唯一通道 — 你没有视觉】你的主对话通道是**纯文本**的:你看不到任何图片像素。画布上的图片节点、资源节点对你而言只是一段元数据和路径,不是画面。
- 凡任务需要知道「图里画的是什么」——反推提示词、参考这张图/这个风格、描述画面、照着改一处细节、判断两张图差异、看图写分镜——**必须调用 vision.caption**(nodeId 或 assetId 指定图片来源,style 选 prompt/zimage/h3/json),拿到文字描述后再干活。
- **禁止**在没看图的情况下凭空编造画面内容并写进 prompt(描述会与真实画面不符,是错误交付)。
- **禁止**用「建节点/连节点」来搪塞看图类需求:节点不能代替你回答,用户要的是描述而不是一张新节点卡。看不到图时也不要假装看过。
- vision.caption 返回的是描述文本,可据此填 shot/image-gen 的 prompt;落地前若描述可能影响后续成本,先向用户复述要点确认。
- **已有产物的节点不需要取帧再读**:要拿它的画面描述,直接 vision.caption(nodeId=该节点) 即可(工具内部会自己解析产物)。**禁止**为了读图先 frames.extract 抽帧、再对新资产节点调 vision.caption —— 那会白白在画布上多插一个资源节点、多花 2-3 轮往返(真实事故:用户要「给镜头写提示词」,模型先抽帧建了个「镜头 03 · 首帧」资产节点再反推,用户看到的是画布凭空多了个资源)。只有当上游是**视频**而你要的是**某一帧当输入图**时,才用 frames.extract。

【写提示词与节点参数的规矩】
- **写提示词一律用 canvas.update_node 的顶层 prompt 参数**(直接传字符串原文):
  canvas.update_node({ nodeId, prompt: "# 场景\n中式庭院…\n\n# 动作\n…" })
  它比塞进 data 更稳 —— data 是对象,容易被序列化成 JSON 字符串,转义符会放大输出量、把输出预算烧光,导致内容被截断成半截甚至整轮空回复(真实事故)。
- 其他短参数(宽高/步数/layers/reuse/accel 等)才走 data 对象。data 必须是**真 JSON 对象**,**绝不**把整个对象序列化成字符串塞进去;解析失败会直接报错、这一轮白费。
- **提示词不能只"心里想着"**:必须真的调工具并确认返回 ✓。视频节点 prompt 为空时 engine.submit 会被拒绝(h3 也会报 prompt must not be empty)。
- 提示词很长(上千字)时:一次写完若被截断,说明输出去预算不够,可拆成两次 update_node(第二次会覆盖,故建议先写主体、再补细节并保留已写内容)。

【选中节点】用户消息带 [当前选中节点] 时,该节点就是本轮默认操作对象:改参数用 canvas.update_node 改它;做下游处理(编辑/裁切/拼接等)用 canvas.connect 把它直接连为新节点的上游。禁止绕道 assets.import 复制它的产物、另建资产节点再连线——那样新链路与原节点脱钩,原节点重新生成后下游不会跟随。

【称呼规则】对用户说话时用节点标题称呼节点(如「镜头 02」「白底产品图」),禁止把节点 id(如 pal1-levm)直接写进回复正文或 ask.user 的选项;id 只用于工具参数。多个节点同名有歧义时,用「标题 + 关键差异(尺寸/位置/序号)」区分,仍不写裸 id。

【示例】用户说「帮我删除所有节点」——错误做法:正文回复「这是不可逆操作,确认吗?」;正确做法:调用 ask.user,question 说明影响面(7 个 shot + 1 个时间线 + 全部连线将被删除),options 给 [{label:「全部删除」, sub:「节点与连线清空,不可恢复」}, {label:「只删未生成的空节点」, recommended:true}, {label:「先不删,我再想想」}]。`);
    // ①b 画布能力知识(节点类型 + 连接器端口语义 + 分镜表流程)——让 Agent 认知本产品的新节点与连线规则
    parts.push(
      ['【画布能力】你能操作以下节点类型:', nodeKindGuide(), '', '连线端口语义(label):', connectorSummary(), '',
        '分镜表(storyboard)是核心流程:表格一行 = 一个分镜,可编辑(增删行/粘贴导入);',
        '用户说「把这篇小说/需求做成短片」时:先用 storyboard.plan 生成分镜表(可传 nodeId 读文档节点,或直接给 brief),',
        '默认分步只出表(让用户确认/改表),用户要求直接铺节点时传 autoMaterialize=true;',
        '已有分镜表要铺节点用 storyboard.materialize;改表后需重新同步(重组提示词写回已铺节点,不重建不删除)。',
        '铺节点只创建节点、不触发运行 —— 生成用 engine.submit 逐节点或批跑,指令明确时直接执行,不必再确认。'].join('\n'),
    );
    // ①c 当前画布激活技能(Agent 指令段注入;full=全量 / summary=摘要+skills.read 提示。
    //  解析器缺失或技能不存在时静默跳过,保持零开销)
    const activeSkillId = m.canvasMemory[canvasId]?.activeSkillId;
    if (activeSkillId && resolveSkill) {
      const skill = resolveSkill(activeSkillId);
      if (skill?.instructions) {
        parts.push(
          skill.inject === 'summary'
            ? `【当前技能】${skill.name}(summary 模式 · 已激活):${skill.instructions.slice(0, 160)}…\n需要完整指令时调用 skills.read(skillId="${activeSkillId}")`
            : `【当前技能】${skill.name} 的操作指令:\n${skill.instructions}`,
        );
      } else if (skill) {
        parts.push(`【当前技能】${skill.name} · 画布模板已激活(该技能无操作指令段)`);
      }
    }
    /* ①c′ 技能流程不得跳步(2026-10-09 「测试1」事故)。
     *
     * 事故:激活了 3d-animation-short,但它是 summary 模式 → 只看到流程名;
     * Agent 也没调 skills.read(recall 里 0 次),于是不知道「角色卡是权威身份源」,
     * 从分镜表直接跳去 storyboard.materialize,8 个镜头的人物各画各的、毫无一致性。
     * 用户的原话是「拆分镜头后并没有生成人物参考图」。
     *
     * 两道防线(技能已改 full 是治本,这里是治标兜底):
     *   ① summary 模式下**必须先 skills.read** —— 只看到 160 字摘要就动手,
     *      等于没读手册;这正是本次事故的直接原因。
     *   ② 涉及角色/场景一致性的技能,**先出角色卡与场景卡再铺节点** ——
     *      一致性靠的是参考图连线(image-gen → image-gen 的 ref-image),不是提示词措辞;
     *      跳过资产设定直接铺镜头,后面画多少张都对不上。 */
    if (activeSkillId && resolveSkill) {
      const sk = resolveSkill(activeSkillId);
      if (sk?.instructions) {
        parts.push(
          [
            '【技能执行硬规矩】',
            ...(sk.inject === 'summary'
              ? [`⚠️ 本技能是 summary 注入(上下文只有前 160 字摘要)。**动手前必须先调用 skills.read(skillId="${activeSkillId}") 读全文** —— 只凭摘要执行等于没读手册(真实事故:模型没读全文就跳过角色卡,镜头画出来人物全不一致)。`]
              : []),
            '⚠️ **技能流程的步骤顺序不可跳步**。若技能要求先做「角色卡 / 场景卡」这类一致性资产,必须**先把它们做成画布节点并生成产物**、再铺镜头与分镜:',
            '- 一致性靠的是**参考图连线**,不是提示词措辞。仅靠文字描述「红衣女」,每个镜头都会重画一张不同的脸。',
            '- 正确做法:先建 image-gen 角色卡/场景卡节点 → `engine.submit` 出图 → 再 `canvas.connect`(label=ref-image)把它们连到各分镜的 image-gen 与 shot 上,让每个镜头都引用同一张参考图。',
            '- 用户跳步催促(如直接说「铺节点并生成」)时,也要先补齐前置资产并说明原因,不要把跳过的步骤静默省掉。',
          ].join('\n'),
        );
      }
    }
    const core = m.core;
    if (core.projectGoal) parts.push(`【项目目标】${core.projectGoal}`);
    if (core.styleGuide) parts.push(`【风格规则】${core.styleGuide}`);
    if (core.constraints) parts.push(`【硬性约束】${core.constraints}`);
    if (core.userPreferences) parts.push(`【用户偏好】${core.userPreferences}`);

    // ①d 当前画布实时状态(节点/连线摘要)——让 Agent 首轮就感知画布轮廓,不必盲调 list_nodes
    if (canvas && (canvas.nodes.length > 0 || canvas.edges.length > 0)) {
      parts.push(MemoryStore.canvasStateSummary(canvas));
    }

    // ② 当前画布的对话压缩摘要(/compact 生成)注入 —— 压缩后仍保留全局脉络
    const curMem = m.canvasMemory[canvasId];
    if (curMem?.conversationSummary) {
      parts.push(`【本画布对话摘要(已压缩)】${curMem.conversationSummary}`);
    }

    // ② 其他画布的 summary 注入(当前画布除外)
    const others = Object.entries(m.canvasMemory).filter(([cid]) => cid !== canvasId);
    if (others.length > 0) {
      parts.push('【本项目的其他画布】');
      for (const [cid, cm] of others) {
        const nodePart = cm.nodeCount > 0 ? `(${cm.nodeCount} 节点)` : '(空)';
        parts.push(`- 画布 ${cid} ${nodePart}: ${cm.summary || '暂无总结'}`);
      }
    }

    // ③ 当前画布 recall(最近 N 条) —— 转 messages
    //    role=system(工具成功后的动作记录)也注入:让下一轮感知"刚才发生了什么",避免凭对话文本猜画布状态
    //    连续重复的系统记录(如必查规则下的「已执行 canvas.get_node」×5)合并为「… ×N」,不占满注入窗口
    const recent = this.recentRecall(projectId, canvasId);
    const collapsed: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    const counts: number[] = [];
    for (const r of recent) {
      const role = r.role as 'user' | 'assistant' | 'system';
      const last = collapsed[collapsed.length - 1];
      if (role === 'system' && last && last.role === 'system' && last.content === r.content) {
        counts[counts.length - 1] = (counts[counts.length - 1] ?? 1) + 1;
      } else {
        collapsed.push({ role, content: r.content });
        counts.push(1);
      }
    }
    const messages = collapsed.map((msg, i) => {
      const n = counts[i] ?? 1;
      return n > 1 ? { ...msg, content: `${msg.content} ×${n}` } : msg;
    });

    // ③b 钉住当前任务链的首条用户指令:工具调用密集时原始指令可能掉出 recall 窗口
    //    (真实事故:「编辑图片让女孩站立」第二轮起即丢失),这里兜底注入,直到用户发出新指令自然替换
    const pinned = this.pinnedInstruction(projectId, canvasId);
    if (pinned && !messages.some((msg) => msg.role === 'user' && msg.content === pinned)) {
      parts.push(
        `【进行中的任务】用户最初指令:「${pinned.slice(0, 200)}」——后续的问答与确认都围绕它推进,执行时不得丢失该目标;若用户最新消息开启了新任务,以最新消息为准。`,
      );
    }

    // ④ archival 检索注入(进 system prompt)
    const arc = this.searchArchival(projectId, userInput);
    if (arc.length > 0) {
      parts.push('【项目记忆(相关)】');
      for (const a of arc) parts.push(`- ${a.text}`);
    }

    return { systemPrompt: parts.join('\n\n'), messages };
  }

  /** 生成画布 summary(供切换画布时调用;LLM 失败时调用方给 fallback) */
  static summarizeFallback(canvasName: string, nodes: Array<{ kind: string; label?: string }>): string {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    const parts = Object.entries(counts).map(([k, v]) => `${v}个${k}`);
    return `「${canvasName}」: ${parts.join('、') || '空白画布'}`.slice(0, SUMMARY_FALLBACK_LEN);
  }
}