/**
 * Pi Planner — 通过 @earendil-works/pi-ai 调用 LLM 生成镜头规划
 *
 * 模式(按优先级):
 * 1. 远端 OpenAI 兼容(env 或显式参数):
 *    BIGBOTART_LLM_BASE_URL / BIGBOTART_LLM_API_KEY / BIGBOTART_LLM_MODEL
 *    例:DeepSeek(baseUrl https://api.deepseek.com/v1)、GLM、Kimi、MiniMax、Grok(xAI) 均兼容
 * 2. 本地 LM Studio(Ornith-1.5)
 * 3. 以上均不可用 → 回退 deterministicPlanner(骨架期闭环不中断)
 *
 * 已确认:pi 以子进程隔离运行(Node ≥22.19),本文件在 Agent worker 内执行。
 */
import { createModels, createProvider, type Context, type Message } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { randomUUID } from 'node:crypto';
import type { CanvasEdge, CanvasNode, LlmProtocol, LlmSource } from '@bigbotart/shared';
import { STORYBOARD_HEAD, tableToGfm, storyboardMarkdown, withOpenCodeGoHeaders } from '@bigbotart/shared';
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
    /** 硬切 = 新构图(换场景/服装/体位);接尾帧 = 从上一镜最后一帧接着动 */
    衔接?: '硬切' | '接尾帧';
    /** 本镜出场的角色卡/场景卡名,逗号分隔;空镜留空 */
    角色?: string;
    /** 以下扩展字段均可选;留空时表格与提示词都不占位 */
    焦段?: string;
    水平角度?: string;
    机位高度?: string;
    构图?: string;
    视线?: string;
    焦点?: string;
    稳定性?: string;
    光位?: string;
    声景?: string;
    配乐?: string;
    站位?: string;
    节拍?: string;
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
export const STORYBOARD_SYSTEM_PROMPT = `你是 BigBotArt 的分镜导演 Agent。把用户的创作需求拆成一张分镜表(表格的一行 = 一个分镜 = 一个 shot 节点)。

规则:
1. 输出 JSON(不要 markdown 代码块):{"title": string(分镜表名), "intro": string(拆镜思路), "basePrompt": string(全局质感段——质感词只出现于此,不逐行漂移), "rows": [{画面描述: string, 对白?: string, 景别?: string, 运镜?: string, 时长?: number, 需配图?: boolean, 衔接: "硬切"|"接尾帧", 角色?: string, 提示词?: string, 焦段?: string, 水平角度?: string, 机位高度?: string, 构图?: string, 视线?: string, 焦点?: string, 稳定性?: string, 光位?: string, 声景?: string, 配乐?: string, 站位?: string, 节拍?: string}], "report": string(写给人类的一句话)}
2. 每个镜头默认 2-6 秒;短剧 3-8 行。单段硬上限 15 秒。一行只写一个连续动作,不要把进门、换衣服、换姿势塞进同一行。
3. ⚠️ **单镜长片不要拆行**:需求写「单镜 / 只铺1个shot / 一条 Ns 视频 / 按 0-3、3-6…区间组织提示词」时,**只输出 1 行**,「时长」填总秒数(如 15),五个时间区间全部写进该行「画面描述」。区间是提示词结构,不是多个分镜行 —— 拆成多行会导致时长列变短片、文案仍写总时长(真实事故)。
4. 涉及人物时在「画面描述」显式锁定身份:同一人物全程长相/服装一致、面部不变形。
5. 「衔接」每行必填,只能是「硬切」或「接尾帧」。第 1 行一定是硬切。**硬切**只用于换场景、换人出场、换服装/体位、或时间跳开。**同一地点、同一批角色、动作顺着往下**(对峙→特写→反应→交锋)写接尾帧 —— 不要只因为换了景别/机位就硬切。
6. 「角色」列写本镜出场的角色卡/场景卡短名(与画布标题对应,逗号分隔)。空镜/无人景只写场景卡名或留空,禁止把未出场的角色填进去。同一人物跨 2 镜及以上出现时,每镜都必须给稳定角色名,**即使画布上还没有角色卡也不能留空或写「无角色卡」**;后续会先建卡再铺节点,重复角色缺卡会被一致性门拒绝。
7. 「需配图」:只有这一镜需要单独构图静帧时为 true(角色卡/场景卡已够用则 false)。接尾帧行一律 false。
8. 「提示词」留空:铺节点时由组装器按画面描述/景别/运镜 + basePrompt 生成 H3 五段式(视频)/ Z-Image 六段式(图)。
9. 摄影决策尽量写进扩展字段,不要只在「画面描述」里堆形容词:焦段写「广/标准/长 + 景深意图」;水平角度写「正面/斜侧/正侧/后斜侧/背面」;机位高度写「地平/低仰/平视/高俯/顶视」;构图写「三分法/中心/对角线/对称/负空间/前景遮挡」;稳定性写「稳定/微晃/手持」。视线与焦点可不同。运镜一镜只选一个,可在「运镜」里附一句运动理由。
10. 「光位」写具体光源方向与冷暖;「声景」写具体环境声/动作声,不复述台词;「配乐」写配器与速度,没有就留空;「站位」写人物在画面左右、朝向与距离;「节拍」写本镜叙事职责。信息不足时扩展字段可留空,禁止编造器材型号,禁止写「电影感、8K、大师级」这类空泛词。`;

/**
 * 分镜规划的输出预算(token)。
 *
 * 为什么不是 4000(2026-10-28「剧本生成测试」事故):**推理模型的 reasoning 与正文共用
 * 同一个 max_tokens 池**。实测 MiniMax-M3.1-Flash 配 4000 时:
 * `finish_reason=length`、`completion_tokens=4000`、其中 `reasoning_tokens=3999`、
 * **正文 content 长度为 0** —— 模型在小声思考里没停,一个字正文都没吐出来。
 * 于是 `parseJson` 必然失败 → 抛「LLM 输出不是合法 JSON」→ 静默回退确定性模板 →
 * 用户拿到 4 行泛泛分镜,完全不是自己描述的内容(真实事故:「T台冲突」5 镜只出了 4 行模板)。
 *
 * 对齐 chat 路径的 `LLM_MAX_TOKENS`(32k):reasoning 约占 4k,正文 7k,留足余量。
 */
const STORYBOARD_MAX_TOKENS = Number(process.env.BIGBOTART_STORYBOARD_MAX_TOKENS ?? 32_000);

/** 解析后的 LLM 端点配置 */
export interface LlmEndpoint {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  /** 是否远端(带鉴权) */
  remote: boolean;
  /** 对话协议:chat = /v1/chat/completions(默认),responses = /v1/responses */
  protocol?: LlmProtocol;
}

/** 按协议选 pi-ai 的 api 实现(与 pi-chat 同口径)。 */
function apiImplFor(protocol: LlmProtocol | undefined): ReturnType<typeof openAICompletionsApi> {
  return (protocol === 'responses' ? openAIResponsesApi() : openAICompletionsApi()) as ReturnType<typeof openAICompletionsApi>;
}

/** 按协议给 model.api 打标(pi-ai 用它挑实现)。 */
function modelApiFor(protocol: LlmProtocol | undefined): string {
  return protocol === 'responses' ? 'openai-responses' : 'openai-completions';
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
      protocol: process.env.BIGBOTART_LLM_PROTOCOL === 'responses' ? 'responses' : 'chat',
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
        protocol: llm.protocol ?? 'chat',
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
        const reason = `LLM 端点不可达(${ep.baseUrl})`;
        console.warn(`[pi-planner] ${reason},回退确定性分镜表`);
        return this.markFallback(planStoryboardDeterministic(params), reason);
      }
      const out = await this.generateStoryboard(ep, params.brief);
      return this.toStoryboardPlanResult(params, out);
    } catch (e) {
      const reason = (e as Error).message;
      console.warn('[pi-planner] LLM 分镜表规划失败,回退确定性模板:', reason);
      return this.markFallback(planStoryboardDeterministic(params), reason);
    }
  }

  /**
   * 给兜底结果打上可见标记(2026-10-28 事故)。
   *
   * 兜底产出的 report 与成功路径一字不差,用户无从分辨「LLM 拆的 5 镜」
   * 与「模板按句子数硬切的 4 行」—— 这正是「效果不是描述的那样」的根因。
   * 这里把失败原因写进 report 前缀,让它在对话里就看得见。
   */
  private markFallback(result: PlanStoryboardResult, reason: string): PlanStoryboardResult {
    return {
      ...result,
      fallbackReason: reason,
      report: `⚠️ 已回退到确定性模板分镜表(非 LLM 拆镜):${reason}\n${result.report}`,
    };
  }

  private async generateStoryboard(ep: LlmEndpoint, brief: string): Promise<LlmStoryboardOutput> {
    const model = {
      id: ep.modelId,
      name: ep.modelId,
      api: modelApiFor(ep.protocol),
      provider: 'bigbotart-llm' as const,
      baseUrl: ep.baseUrl,
      reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: STORYBOARD_MAX_TOKENS,
    };
    const provider = createProvider({
      id: 'bigbotart-llm',
      name: 'BigBotArt LLM',
      baseUrl: ep.baseUrl,
      auth: { apiKey: { name: 'BigBotArt LLM', resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: apiImplFor(ep.protocol),
    });
    const models = createModels();
    models.setProvider(provider);

    const messages: Message[] = [
      { role: 'user', content: `创作需求:\n${brief}\n\n请按分镜导演规则输出 JSON 分镜表。`, timestamp: Date.now() },
    ];
    const context: Context = { systemPrompt: STORYBOARD_SYSTEM_PROMPT, messages };

    const assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
      maxTokens: STORYBOARD_MAX_TOKENS,
      temperature: 0.7,
      apiKey: ep.apiKey ?? 'unused',
      // OpenCode Go:x-opencode-session 必填;规划是单次调用,用一次性 session
      headers: withOpenCodeGoHeaders(ep.baseUrl, `plan-sb-${randomUUID()}`),
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
    if (!parsed) {
      /* 截断与「模型没按 schema 输出」是两回事,必须分开报 —— 上层据此决定
       * 「重试」还是「回退」,混成一句「不是合法 JSON」会让人无法判断该不该重试。
       * ① stopReason==='length':推理模型把输出预算吃光,正文为空或半截(JSON 断在半路);
       * ② 正文非空却解不出:模型没按 `{title,intro,basePrompt,rows,report}` 输出。 */
      if (assistant.stopReason === 'length') {
        throw new Error(
          `LLM 输出被 token 上限截断(stopReason=length,预算 ${STORYBOARD_MAX_TOKENS}):` +
            `正文 ${textContent.length} 字。请调大 BIGBOTART_STORYBOARD_MAX_TOKENS 或减少镜头数。`,
        );
      }
      if (!textContent.trim()) {
        throw new Error(
          `LLM 没有输出正文(content 为空,stopReason=${assistant.stopReason}):` +
            `该模型可能把输出预算全部用于推理,或拒绝本次请求。`,
        );
      }
      throw new Error(
        `LLM 输出不是合法 JSON(已尝试剥围栏并定位首个 {;正文 ${textContent.length} 字):` +
          `模型可能没按 {title,intro,basePrompt,rows,report} 的结构输出。`,
      );
    }
    if (!Array.isArray((parsed as { rows?: unknown }).rows)) {
      const keys = Object.keys(parsed as object).join(',');
      throw new Error(
        `LLM 输出的 JSON 缺少 rows 数组(实际顶层键: ${keys || '无'}):` +
          `模型没按分镜表 schema 输出,已放弃回退以免产出空表。`,
      );
    }
    return parsed as unknown as LlmStoryboardOutput;
  }

  private toStoryboardPlanResult(params: PlanStoryboardParams, out: LlmStoryboardOutput): PlanStoryboardResult {
    const head = [...STORYBOARD_HEAD] as string[];
    const rows = (out.rows ?? []).map((r, i) => {
      const cells: Record<string, string> = {
        镜号: String(i + 1),
        画面描述: String(r.画面描述 ?? ''),
        '对白/旁白': String(r.对白 ?? ''),
        景别: String(r.景别 ?? '中景'),
        运镜: String(r.运镜 ?? '固定'),
        '时长(s)': String(typeof r.时长 === 'number' ? r.时长 : 5),
        需配图: r.需配图 === false ? '否' : '是',
        '提示词(可选)': String(r.提示词 ?? ''),
        衔接: r.衔接 === '硬切' || (r.衔接 !== '接尾帧' && i === 0) ? '硬切' : '接尾帧',
        角色: String(r.角色 ?? ''),
        焦段: String(r.焦段 ?? ''),
        水平角度: String(r.水平角度 ?? ''),
        机位高度: String(r.机位高度 ?? ''),
        构图: String(r.构图 ?? ''),
        视线: String(r.视线 ?? ''),
        焦点: String(r.焦点 ?? ''),
        稳定性: String(r.稳定性 ?? ''),
        光位: String(r.光位 ?? ''),
        声景: String(r.声景 ?? ''),
        配乐: String(r.配乐 ?? ''),
        '站位(blocking)': String(r.站位 ?? ''),
        节拍: String(r.节拍 ?? ''),
      };
      return head.map((name) => cells[name] ?? '');
    });
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
      api: modelApiFor(ep.protocol),
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
      api: apiImplFor(ep.protocol),
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
      headers: withOpenCodeGoHeaders(ep.baseUrl, `plan-${randomUUID()}`),
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