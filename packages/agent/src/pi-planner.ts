/**
 * Pi Planner — 通过 @earendil-works/pi-ai 调用 LLM 生成镜头规划
 *
 * 模式(按优先级):
 * 1. 远端 OpenAI 兼容(env 或显式参数):
 *    BIGBOTART_LLM_BASE_URL / BIGBOTART_LLM_API_KEY / BIGBOTART_LLM_MODEL
 *    例:DeepSeek(baseUrl https://api.deepseek.com/v1)、GLM、Kimi、MiniMax 均兼容
 * 2. 本地 LM Studio(Ornith-1.5)
 * 3. 以上均不可用 → 回退 deterministicPlanner(骨架期闭环不中断)
 *
 * 已确认:pi 以子进程隔离运行(Node ≥22.19),本文件在 Agent worker 内执行。
 */
import { createModels, createProvider, type Context, type Message } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { CanvasEdge, CanvasNode, LlmSource } from '@bigbotart/shared';
import { STORYBOARD_HEAD, tableToGfm, storyboardMarkdown } from '@bigbotart/shared';
import type { PlanParams, PlanResult, PlanStoryboardParams, PlanStoryboardResult } from './protocol.js';
import { planDeterministic, planStoryboardDeterministic, buildStoryboardMaterialized } from './plan.js';

let seq = 0;
const nid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** h3.c 帧数对齐(5+17n):与 h3 --seconds 的换算一致(seconds×24 后向上对齐) */
function h3AlignFrames(f: number): number {
  const v = Math.max(5, Math.round(f));
  const r = (v - 5) % 17;
  return r === 0 ? v : v + 17 - r;
}

/** LLM 结构化输出 schema(镜头规划) */
export interface LlmPlanOutput {
  brief: string;
  shots: {
    scene: string;
    action: string;
    camera: string;
    look: string;
    audio: string;
    durationHintSec?: number;
    width?: number;
    height?: number;
  }[];
  report: string;
}

/** LLM 结构化输出 schema(分镜表) */
export interface LlmStoryboardOutput {
  title: string;
  intro: string;
  basePrompt?: string;
  rows: {
    画面描述: string;
    对白?: string;
    景别?: string;
    运镜?: string;
    时长?: number;
    需配图?: boolean;
    提示词?: string;
  }[];
  report: string;
}

/** 系统提示:把用户需求拆成可拍摄镜头的 H3 五段式 */
const SYSTEM_PROMPT = `你是 BigBotArt 的视频导演 Agent。把用户的创作需求拆解为一组可拍摄的视频镜头。

规则:
1. 每个镜头都必须写全 H3 五段式:Scene(场景)/ Action(动作)/ Camera(镜头)/ Look(光影与风格)/ Audio(声音)。
2. 涉及人物时,在 Scene/Action 中显式锁定身份:同一人物全程长相/发型/服装一致、面部不变形(写入不变的视觉特征)。
3. 短视频 1-2 镜,叙事长片 3-6 镜;每个镜头建议 2-6 秒。
4. 返回 JSON(不要输出 markdown 代码块):{"brief": string, "shots": [{scene, action, camera, look, audio, durationHintSec?, width?, height?}], "report": string}
5. report 用一句话说明拆镜思路,写给人类用户看。`;

/** 系统提示:分镜表(plan-storyboard) */
const STORYBOARD_SYSTEM_PROMPT = `你是 BigBotArt 的分镜导演 Agent。把用户的创作需求拆成一张分镜表(表格的一行 = 一个分镜)。

规则:
1. 输出 JSON(不要 markdown 代码块):{"title": string(分镜表名), "intro": string(拆镜思路), "basePrompt": string(全局质感段——质感词只出现于此,不逐行漂移), "rows": [{画面描述: string, 对白?: string, 景别?: string, 运镜?: string, 时长?: number, 需配图?: boolean, 提示词?: string}], "report": string(写给人类的一句话)}
2. 每个镜头 2-6 秒;短剧 3-8 行,长片按时长切片。
3. 涉及人物时在「画面描述」显式锁定身份:同一人物全程长相/服装一致、面部不变形。
4. 「需配图」默认 true(该行需要关键帧/首帧图);对白较多或纯转场镜头可为 false。
5. 「提示词」留空:铺节点时由组装器按画面描述/景别/运镜 + basePrompt 生成 H3 五段式(视频)/ Z-Image 六段式(图)。`;

/** 解析后的 LLM 端点配置 */
export interface LlmEndpoint {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  /** 是否远端(带鉴权) */
  remote: boolean;
}

export interface PiPlannerOptions {
  /** 远端 OpenAI 兼容端点(显式传入优先于 env) */
  remote?: LlmEndpoint;
  /** 本地 LM Studio 配置 */
  lmStudio?: { baseUrl?: string; modelId?: string };
  timeoutMs?: number;
}

export class PiPlanner {
  private opts: Required<Pick<PiPlannerOptions, 'timeoutMs'>> & PiPlannerOptions;

  constructor(opts: PiPlannerOptions = {}) {
    this.opts = {
      timeoutMs: opts.timeoutMs ?? 90_000,
      ...opts,
    };
  }

  /** 从环境变量读取远端端点(BIGBOTART_LLM_*) */
  static remoteFromEnv(): LlmEndpoint | undefined {
    const baseUrl = process.env.BIGBOTART_LLM_BASE_URL;
    if (!baseUrl) return undefined;
    return {
      baseUrl,
      apiKey: process.env.BIGBOTART_LLM_API_KEY,
      modelId: process.env.BIGBOTART_LLM_MODEL ?? 'deepseek-chat',
      remote: true,
    };
  }

  /** 解析本次调用的端点:显式 remote > env remote > LM Studio */
  private resolveEndpoint(llm?: LlmSource): LlmEndpoint {
    if (llm?.kind === 'openai-compatible') {
      return {
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        modelId: llm.model ?? (this.opts.remote?.modelId ?? 'deepseek-chat'),
        remote: true,
      };
    }
    const env = PiPlanner.remoteFromEnv();
    if (env) return env;
    if (this.opts.remote) return this.opts.remote;
    // 本地 LM Studio 兜底
    return {
      baseUrl: this.opts.lmStudio?.baseUrl ?? 'http://127.0.0.1:1234/v1',
      modelId: this.opts.lmStudio?.modelId ?? 'ornith-1.5-35b-a3b-abliterated-mlx',
      remote: false,
    };
  }

  /** 端点可用性探测:远端检查 HTTP 200,本地同样 */
  private async endpointAvailable(ep: LlmEndpoint): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const caller = ep.remote ? (await import('node:https')).request : globalThis.fetch;
      void caller;
      const res = await fetch(`${ep.baseUrl}/models`, {
        signal: AbortSignal.timeout(4000),
        headers,
      });
      if (!res.ok && ep.remote && ep.apiKey) {
        // 部分远端 /models 需鉴权,401 不代表不可用;chat 探测兜底
        return true;
      }
      return res.ok;
    } catch {
      // 网络不可达但配置了远端 → 让调用方报错回退,而不是静默本地
      return !ep.remote;
    }
  }

  /** 用 pi-ai + LLM 生成规划;失败回退确定性规划 */
  async plan(params: PlanParams, llm?: LlmSource): Promise<PlanResult> {
    const ep = this.resolveEndpoint(llm);
    try {
      const ok = await this.endpointAvailable(ep);
      if (!ok) {
        console.warn(`[pi-planner] 端点不可达(${ep.baseUrl}),回退确定性规划`);
        return planDeterministic(params);
      }
      const out = await this.generate(ep, params.brief);
      return this.toPlanResult(params, out);
    } catch (e) {
      console.warn('[pi-planner] LLM 规划失败,回退确定性规划:', (e as Error).message);
      return planDeterministic(params);
    }
  }

  /** 分镜表规划(plan-storyboard);失败回退确定性模板 */
  async planStoryboard(params: PlanStoryboardParams, llm?: LlmSource): Promise<PlanStoryboardResult> {
    const ep = this.resolveEndpoint(llm);
    try {
      const ok = await this.endpointAvailable(ep);
      if (!ok) {
        console.warn(`[pi-planner] 端点不可达(${ep.baseUrl}),回退确定性分镜表`);
        return planStoryboardDeterministic(params);
      }
      const out = await this.generateStoryboard(ep, params.brief);
      return this.toStoryboardPlanResult(params, out);
    } catch (e) {
      console.warn('[pi-planner] LLM 分镜表规划失败,回退确定性模板:', (e as Error).message);
      return planStoryboardDeterministic(params);
    }
  }

  private async generateStoryboard(ep: LlmEndpoint, brief: string): Promise<LlmStoryboardOutput> {
    const model = {
      id: ep.modelId,
      name: ep.modelId,
      api: 'openai-completions' as const,
      provider: 'bigbotart-llm' as const,
      baseUrl: ep.baseUrl,
      reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 2400,
    };
    const provider = createProvider({
      id: 'bigbotart-llm',
      name: 'BigBotArt LLM',
      baseUrl: ep.baseUrl,
      auth: { apiKey: { name: 'BigBotArt LLM', resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);

    const messages: Message[] = [
      { role: 'user', content: `创作需求:\n${brief}\n\n请按分镜导演规则输出 JSON 分镜表。`, timestamp: Date.now() },
    ];
    const context: Context = { systemPrompt: STORYBOARD_SYSTEM_PROMPT, messages };

    const assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
      maxTokens: 2400,
      temperature: 0.7,
      apiKey: ep.apiKey ?? 'unused',
    });
    const blocks = assistant.content ?? [];
    const textContent = blocks
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    const thinkingContent = blocks
      .filter((c) => c.type === 'thinking')
      .map((c) => ('thinking' in c ? c.thinking : ''))
      .join('');
    let parsed = this.parseJson(textContent);
    if (!parsed) {
      parsed = this.parseJson(textContent + thinkingContent);
    }
    if (!parsed) throw new Error('LLM 输出不是合法 JSON');
    return parsed as unknown as LlmStoryboardOutput;
  }

  private toStoryboardPlanResult(params: PlanStoryboardParams, out: LlmStoryboardOutput): PlanStoryboardResult {
    const head = [...STORYBOARD_HEAD] as string[];
    const rows = (out.rows ?? []).map((r, i) => [
      String(i + 1),
      String(r.画面描述 ?? ''),
      String(r.对白 ?? ''),
      String(r.景别 ?? '中景'),
      String(r.运镜 ?? '固定'),
      String(typeof r.时长 === 'number' ? r.时长 : 5),
      r.需配图 === false ? '否' : '是',
      String(r.提示词 ?? ''),
    ]);
    const gfm = tableToGfm(head, rows);
    const title = out.title || '新分镜 · 分镜表';
    const basePrompt = out.basePrompt ?? params.basePrompt ?? '';
    const storyboard: CanvasNode = {
      id: nid('sb'),
      kind: 'storyboard',
      position: { x: 420, y: 80 },
      label: title,
      data: {
        markdown: storyboardMarkdown(title, out.intro || '', head, rows),
        basePrompt,
        lastTable: gfm,
        aspect: '16:9',
        tier: 'default',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { images, shots, edges } = params.autoMaterialize
      ? buildStoryboardMaterialized(storyboard.id, head, rows, params.basePrompt)
      : { images: [], shots: [], edges: [] };
    return { storyboard, images, shots, edges, report: out.report || `已生成分镜表:${rows.length} 行` };
  }

  private async generate(ep: LlmEndpoint, brief: string): Promise<LlmPlanOutput> {
    const model = {
      id: ep.modelId,
      name: ep.modelId,
      api: 'openai-completions' as const,
      provider: 'bigbotart-llm' as const,
      baseUrl: ep.baseUrl,
      reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 2000,
    };
    const provider = createProvider({
      id: 'bigbotart-llm',
      name: 'BigBotArt LLM',
      baseUrl: ep.baseUrl,
      auth: { apiKey: { name: 'BigBotArt LLM', resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);

    const messages: Message[] = [
      { role: 'user', content: `创作需求:\n${brief}\n\n请按导演规则输出 JSON 镜头规划。`, timestamp: Date.now() },
    ];
    const context: Context = { systemPrompt: SYSTEM_PROMPT, messages };

    const assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
      maxTokens: 2000,
      temperature: 0.7,
      // 远端带真 key;本地无鉴权用占位(pi-ai 需要显式 apiKey)
      apiKey: ep.apiKey ?? 'unused',
    });
    // thinking 模型:JSON 只从 text 块提取(thinking 里常有模型的 JSON 草稿干扰解析)
    const blocks = assistant.content ?? [];
    const textContent = blocks
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    const thinkingContent = blocks
      .filter((c) => c.type === 'thinking')
      .map((c) => ('thinking' in c ? c.thinking : ''))
      .join('');
    let parsed = this.parseJson(textContent);
    if (!parsed) {
      // text 无合法 JSON 时,回退全量(含 thinking)
      parsed = this.parseJson(textContent + thinkingContent);
    }
    if (!parsed) throw new Error('LLM 输出不是合法 JSON');
    return parsed;
  }

  /** 宽容解析 JSON(剥掉 markdown 围栏;优先定位 {"brief" 起点) */
  private parseJson(text: string): LlmPlanOutput | null {
    try {
      const cleaned = text
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();
      let start = cleaned.indexOf('{"brief"');
      if (start < 0) start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end < 0 || end <= start) return null;
      return JSON.parse(cleaned.slice(start, end + 1)) as LlmPlanOutput;
    } catch {
      return null;
    }
  }

  private toPlanResult(params: PlanParams, out: LlmPlanOutput): PlanResult {
    const docNode: CanvasNode = {
      id: nid('doc'),
      kind: 'document',
      position: { x: 60, y: 80 },
      label: 'Brief',
      data: { markdown: `# 《${params.projectName ?? '新项目'}》— 创作 Brief\n\n${out.brief}\n` },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const shots: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];
    out.shots.forEach((s, i) => {
      const prompt = [
        `Scene: ${s.scene}`,
        `Action: ${s.action}`,
        `Camera: ${s.camera}`,
        `Look: ${s.look}`,
        `Audio: ${s.audio}`,
      ].join('\n');
      const shot: CanvasNode = {
        id: nid('shot'),
        kind: 'shot',
        position: { x: 500, y: 80 + i * 220 },
        label: `镜头 ${i + 1}`,
        data: {
          engine: 'mock', // 骨架期 mock;引导向导就绪后切 h3c
          mode: 'text2video',
          prompt,
          width: s.width ?? 768,
          height: s.height ?? 768,
          frames: h3AlignFrames((s.durationHintSec ?? 4) * 24),
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
    });

    return { document: docNode, shots, edges, report: out.report };
  }
}