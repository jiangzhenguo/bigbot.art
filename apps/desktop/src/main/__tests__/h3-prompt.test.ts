/**
 * h3.write_prompt — 镜头提示词不由主 Agent 直接写。
 * 模式由连线判定;规范在服务端载入;写作调用失败或过短时不改节点。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@bigbotart/shared';
import {
  MIN_H3_PROMPT_CHARS,
  buildH3WriteMessages,
  classifyH3PromptMode,
  describeInboundRefs,
  extractPromptText,
  rejectDirectShotPrompt,
  requestH3PromptCompletion,
  shotCreateCarriesPrompt,
} from '../h3-prompt.js';

const PROJECT = 'proj-h3';
const CANVAS = 'cv-h3';
const LONG = 'Scene: dusk courtyard, she turns toward the gate. Camera: slow push-in. Audio: wind through leaves.';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

describe('classifyH3PromptMode', () => {
  it('无参考 → T2VA;仅首帧 → I2VA;首尾帧 → FL2VA;仅尾帧 → L2VA', () => {
    expect(classifyH3PromptMode([])).toBe('T2VA');
    expect(classifyH3PromptMode([{ label: 'prompt' }])).toBe('T2VA');
    expect(classifyH3PromptMode([{ label: 'first-frame' }])).toBe('I2VA');
    expect(classifyH3PromptMode([{ label: 'first-frame' }, { label: 'last-frame' }])).toBe('FL2VA');
    expect(classifyH3PromptMode([{ label: 'last-frame' }])).toBe('L2VA');
  });

  it('有 ref-image / ref-video / ref-audio 时一律 Ref2VA,优先于首尾帧', () => {
    expect(classifyH3PromptMode([{ label: 'ref-image' }])).toBe('Ref2VA');
    expect(classifyH3PromptMode([{ label: 'ref-video' }])).toBe('Ref2VA');
    expect(classifyH3PromptMode([{ label: 'ref-audio' }])).toBe('Ref2VA');
    expect(classifyH3PromptMode([{ label: 'first-frame' }, { label: 'ref-image' }])).toBe('Ref2VA');
  });
});

describe('describeInboundRefs', () => {
  it('按连线顺序编号,首帧不占 Picture,prompt 边忽略', () => {
    const text = describeInboundRefs([
      { label: 'prompt', sourceTitle: '分镜表' },
      { label: 'first-frame', sourceTitle: '确认静帧' },
      { label: 'ref-image', sourceTitle: '苏青' },
      { label: 'ref-image', sourceTitle: '庭院' },
      { label: 'ref-video', sourceTitle: '上镜成片' },
      { label: 'ref-audio', sourceTitle: '主音轨' },
    ]);
    expect(text).not.toContain('分镜表');
    expect(text).toContain('first-frame「确认静帧」→ 首帧图');
    expect(text).toContain('<Picture 1>');
    expect(text).toContain('苏青');
    expect(text).toContain('<Picture 2>');
    expect(text).toContain('<Video 1>');
    expect(text).toContain('<Audio 1>');
  });
});

describe('闸门谓词', () => {
  it('只有 shot 且 patch 含 prompt 键才拒绝', () => {
    expect(rejectDirectShotPrompt('image-gen', { prompt: 'x' })).toBeNull();
    expect(rejectDirectShotPrompt('shot', { width: 544 })).toBeNull();
    expect(rejectDirectShotPrompt('shot', undefined)).toBeNull();
    expect(rejectDirectShotPrompt('shot', { prompt: '' })).toContain('h3.write_prompt');
  });

  it('创建时非空 prompt 才算携带', () => {
    expect(shotCreateCarriesPrompt(undefined)).toBe(false);
    expect(shotCreateCarriesPrompt({})).toBe(false);
    expect(shotCreateCarriesPrompt({ prompt: '  ' })).toBe(false);
    expect(shotCreateCarriesPrompt({ prompt: '有内容' })).toBe(true);
  });
});

describe('extractPromptText', () => {
  it('剥掉思考块和代码围栏', () => {
    const raw = `<think>先想一下</think>\n\`\`\`text\n${LONG}\n\`\`\``;
    const got = extractPromptText(raw);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toBe(LONG);
  });

  it('过短拒绝', () => {
    const got = extractPromptText('太短');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain(String(MIN_H3_PROMPT_CHARS));
  });
});

describe('buildH3WriteMessages', () => {
  it('系统提示含规范与场景技能约束,用户消息含模式、时长、参考和重写底稿', () => {
    const msg = buildH3WriteMessages({
      spec: 'SPEC-BODY',
      mode: 'I2VA',
      title: '镜头 03',
      seconds: 8,
      brief: '她推开院门',
      previous: '旧提示词原文',
      refsText: '- first-frame「静帧」→ 首帧图',
      skillName: '3D动画短片',
      skillInstructions: '角色卡锁定红衣',
    });
    expect(msg.system).toContain('SPEC-BODY');
    expect(msg.system).toContain('没有工具');
    expect(msg.system).toContain('角色卡锁定红衣');
    expect(msg.system).toContain('3D动画短片');
    expect(msg.user).toContain('I2VA');
    expect(msg.user).toContain('8 秒');
    expect(msg.user).toContain('她推开院门');
    expect(msg.user).toContain('静帧');
    expect(msg.user).toContain('不要原样照抄');
    expect(msg.user).toContain('旧提示词原文');
  });
});

describe('requestH3PromptCompletion', () => {
  const endpoint = { baseUrl: 'http://llm.example/v1/', model: 'm', apiKey: 'k' };

  it('成功返回正文,请求不带 tools', async () => {
    let url = '';
    let body: { tools?: unknown; messages: Array<{ role: string }>; max_tokens: number; temperature?: number } | undefined;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      url = input;
      body = JSON.parse(String(init?.body));
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer k' });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: LONG } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const got = await requestH3PromptCompletion(endpoint, { system: 's', user: 'u' }, fetchImpl);
    expect(url).toBe('http://llm.example/v1/chat/completions');
    expect(body?.tools).toBeUndefined();
    expect(body?.max_tokens).toBe(8000);
    expect(body?.temperature).toBe(0.2);
    expect(body?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(got).toEqual({ ok: true, text: LONG, model: 'm' });
  });

  it('端点只允许 temperature=1(Kimi)→ 去掉 temperature 重试并成功', async () => {
    const temps: Array<number | undefined> = [];
    let calls = 0;
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { temperature?: number };
      temps.push(body.temperature);
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: { message: 'invalid temperature: only 1 is allowed for this model', type: 'invalid_request_error' },
          }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: LONG } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const got = await requestH3PromptCompletion(endpoint, { system: 's', user: 'u' }, fetchImpl);
    expect(calls).toBe(2);
    expect(temps[0]).toBe(0.2);
    expect(temps[1]).toBeUndefined();
    expect(got).toEqual({ ok: true, text: LONG, model: 'm' });
  });

  it('protocol=responses(grok 等只开 /responses)→ 打 /responses,报文用 instructions/input/max_output_tokens', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      url = input;
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: LONG }] }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const got = await requestH3PromptCompletion({ ...endpoint, protocol: 'responses' }, { system: 'SYS', user: 'U' }, fetchImpl);
    expect(url).toBe('http://llm.example/v1/responses');
    expect(body.instructions).toBe('SYS');
    expect(body.input).toBe('U');
    expect(body.max_output_tokens).toBe(8000);
    expect(body.messages).toBeUndefined();
    expect(got).toEqual({ ok: true, text: LONG, model: 'm' });
  });

  it('端点回 ModelProtocolUnsupported → 自动切另一套协议重试一次(2026-10-20 grok 事故)', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string) => {
      urls.push(input);
      if (input.endsWith('/chat/completions')) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'ModelProtocolUnsupported', message: 'Model does not support this protocol.' } }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: LONG }] }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const got = await requestH3PromptCompletion(endpoint, { system: 's', user: 'u' }, fetchImpl);
    expect(urls).toEqual(['http://llm.example/v1/chat/completions', 'http://llm.example/v1/responses']);
    expect(got).toEqual({ ok: true, text: LONG, model: 'm' });
  });

  it('responses 被截断(status=incomplete)→ 不写回', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: LONG }] }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const got = await requestH3PromptCompletion({ ...endpoint, protocol: 'responses' }, { system: 's', user: 'u' }, fetchImpl);
    expect(got.ok).toBe(false);
    expect(String((got as { error?: string }).error)).toContain('截断');
  });

  it('截断、空内容、HTTP 错误、网络失败都不返回可写正文', async () => {
    const lengthFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: LONG } }] }), {
        status: 200,
      })) as typeof fetch;
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '  ' } }] }), {
        status: 200,
      })) as typeof fetch;
    const httpFetch = (async () => new Response('boom', { status: 502 })) as typeof fetch;
    const throwFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    for (const f of [lengthFetch, emptyFetch, httpFetch, throwFetch]) {
      const got = await requestH3PromptCompletion(endpoint, { system: 's', user: 'u' }, f);
      expect(got.ok).toBe(false);
    }
    const length = await requestH3PromptCompletion(endpoint, { system: 's', user: 'u' }, lengthFetch);
    expect(length.ok).toBe(false);
    if (!length.ok) expect(length.error).toContain('length');
  });
});

interface Snap {
  canvases: Array<{
    id: string;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    version: number;
    updatedAt: string;
  }>;
}

function harness(opts: {
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
  activeId?: string;
  skills?: Record<string, { name: string; instructions?: string }>;
  complete?: (projectId: string, messages: { system: string; user: string }) => Promise<
    { ok: true; text: string; model: string } | { ok: false; error: string }
  >;
  saveOk?: boolean;
}) {
  const snapshot: Snap = {
    canvases: [
      {
        id: CANVAS,
        nodes: opts.nodes,
        edges: opts.edges ?? [],
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  const calls: Array<{ system: string; user: string }> = [];
  const h = new ToolHandlers(
    {
      loadProjectCanvases: () => ({ projectId: PROJECT, canvases: snapshot.canvases }),
      saveCanvasSnapshot: () => ({ ok: opts.saveOk !== false }),
    } as never,
    {} as never,
    { get: (id: string) => opts.skills?.[id] } as never,
    {} as never,
    {} as never,
    { getActiveSkillId: () => opts.activeId } as never,
    {
      completeH3Prompt: opts.complete
        ? async (projectId, messages) => {
            calls.push(messages);
            return opts.complete!(projectId, messages);
          }
        : undefined,
    },
  );
  return { h, snapshot, calls };
}

const shot = (prompt = '', seconds?: number): CanvasNode =>
  ({
    id: 'shot-1',
    kind: 'shot',
    label: '镜头 03',
    position: { x: 0, y: 0 },
    data: { engine: 'h3c', prompt, ...(seconds ? { seconds } : {}) },
  }) as unknown as CanvasNode;

describe('h3.write_prompt 工具', () => {
  it('按首帧连线写成 I2VA,附上场景技能,写回节点', async () => {
    const frame: CanvasNode = {
      id: 'img-1',
      kind: 'image-gen',
      label: '确认静帧',
      position: { x: 0, y: 0 },
      data: {},
    } as unknown as CanvasNode;
    const { h, snapshot, calls } = harness({
      nodes: [frame, shot('旧稿', 8)],
      edges: [{ id: 'e1', source: 'img-1', target: 'shot-1', label: 'first-frame' }],
      activeId: '3d-animation-short',
      skills: {
        'h3-prompt-writing': { name: 'H3', instructions: 'SPEC-BODY' },
        '3d-animation-short': { name: '3D动画短片', instructions: '角色卡锁定红衣' },
      },
      complete: async () => ({ ok: true, text: LONG, model: 'm' }),
    });
    const res = await h.call(
      'h3.write_prompt',
      { nodeId: '镜头 03', brief: '她推开院门' },
      { projectId: PROJECT, canvasId: CANVAS },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toContain('I2VA');
    expect(res.result).toContain('尚未提交生成');
    const written = (snapshot.canvases[0]!.nodes[1]!.data as { prompt?: string }).prompt;
    expect(written).toBe(LONG);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain('SPEC-BODY');
    expect(calls[0]!.system).toContain('角色卡锁定红衣');
    expect(calls[0]!.user).toContain('I2VA');
    expect(calls[0]!.user).toContain('确认静帧');
    expect(calls[0]!.user).toContain('8 秒');
    expect(calls[0]!.user).toContain('旧稿');
  });

  it('激活的就是 H3 规范技能时不把同一份规范再附一遍', async () => {
    const { h, calls } = harness({
      nodes: [shot()],
      activeId: 'h3-prompt-writing',
      skills: { 'h3-prompt-writing': { name: 'H3', instructions: 'SPEC-BODY-UNIQUE' } },
      complete: async () => ({ ok: true, text: LONG, model: 'm' }),
    });
    const res = await h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok).toBe(true);
    expect(calls[0]!.system.split('SPEC-BODY-UNIQUE').length - 1).toBe(1);
    expect(calls[0]!.system).not.toContain('当前画布激活技能');
  });

  it('模型失败或正文过短时不改节点', async () => {
    const fail = harness({
      nodes: [shot('保持不动')],
      complete: async () => ({ ok: false, error: '端点超时', model: 'm' } as never),
    });
    const a = await fail.h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(a.ok).toBe(false);
    expect((fail.snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('保持不动');

    const short = harness({
      nodes: [shot('保持不动')],
      complete: async () => ({ ok: true, text: '```\n太短\n```', model: 'm' }),
    });
    const b = await short.h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(b.ok).toBe(false);
    expect((short.snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('保持不动');
  });

  it('代码围栏里的正文会剥掉再写入', async () => {
    const { h, snapshot } = harness({
      nodes: [shot()],
      complete: async () => ({ ok: true, text: '```text\n' + LONG + '\n```', model: 'm' }),
    });
    const res = await h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok).toBe(true);
    expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe(LONG);
  });

  it('非镜头不调用写作,未注入补全时明确失败', async () => {
    const img = { id: 'img', kind: 'image-gen', label: '图', position: { x: 0, y: 0 }, data: { prompt: '旧' } } as unknown as CanvasNode;
    let called = false;
    const { h } = harness({
      nodes: [img],
      complete: async () => {
        called = true;
        return { ok: true, text: LONG, model: 'm' };
      },
    });
    const res = await h.call('h3.write_prompt', { nodeId: 'img', brief: 'x' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不是镜头');
    expect(called).toBe(false);

    const bare = harness({ nodes: [shot('旧')] });
    const miss = await bare.h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(miss.ok).toBe(false);
    expect(miss.result).toContain('未接上文本补全');
    expect((bare.snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('旧');
  });

  it('写回被快照拒绝时恢复旧提示词', async () => {
    const { h, snapshot } = harness({
      nodes: [shot('旧稿')],
      saveOk: false,
      complete: async () => ({ ok: true, text: LONG, model: 'm' }),
    });
    const res = await h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok).toBe(false);
    expect(res.result).toContain('写回画布失败');
    expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('旧稿');
  });

  it('LLM 期间版本被顶(stale)→ 重载最新快照重试保存成功,且提示词只生成一次', async () => {
    // 事故回归(2026-10-15「骑士小猫」):completeH3Prompt 耗时数十秒,期间渲染层/队列
    // 保存了新版本,持旧快照整体写回被版本防护拒绝 —— 实测连续 11 次失败,模型反复重写。
    // 修法:LLM 完成后重新加载快照再落 prompt;stale 时重载重试,不重新生成。
    const snapshot: Snap = {
      canvases: [{ id: CANVAS, nodes: [shot('旧稿')], edges: [], version: 1, updatedAt: new Date().toISOString() }],
    };
    let completions = 0;
    let saves = 0;
    let loads = 0;
    const h = new ToolHandlers(
      {
        loadProjectCanvases: () => {
          loads += 1;
          return { projectId: PROJECT, canvases: snapshot.canvases };
        },
        saveCanvasSnapshot: () => {
          saves += 1;
          return { ok: saves > 1 }; // 第一次保存被拒(模拟 stale),第二次成功
        },
      } as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      { getActiveSkillId: () => undefined } as never,
      {
        completeH3Prompt: async () => {
          completions += 1;
          return { ok: true as const, text: LONG, model: 'm' };
        },
      },
    );
    const res = await h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok).toBe(true);
    expect(completions).toBe(1); // 重试不重新生成提示词
    expect(saves).toBe(2);
    expect(loads).toBeGreaterThanOrEqual(2); // 写回前重新加载了快照
    expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe(LONG);
  });
});

describe('canvas.create_node — shot 不能带 prompt', () => {
  it('带 prompt 的镜头不创建;不带 prompt 的镜头、带 prompt 的图片照常创建', async () => {
    const { h, snapshot } = harness({ nodes: [] });
    const blocked = await h.call(
      'canvas.create_node',
      { kind: 'shot', label: '镜头 01', data: { prompt: '不要直接写进来', seconds: 5, width: 544, height: 544 } },
      { projectId: PROJECT, canvasId: CANVAS },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.result).toContain('h3.write_prompt');
    expect(snapshot.canvases[0]!.nodes).toHaveLength(0);

    const okShot = await h.call(
      'canvas.create_node',
      { kind: 'shot', label: '镜头 01', data: { seconds: 5, width: 544, height: 544 } },
      { projectId: PROJECT, canvasId: CANVAS },
    );
    expect(okShot.ok).toBe(true);
    expect(snapshot.canvases[0]!.nodes).toHaveLength(1);
    expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBeUndefined();

    const okImg = await h.call(
      'canvas.create_node',
      { kind: 'image-gen', label: '产品图', data: { prompt: '白底保温杯' } },
      { projectId: PROJECT, canvasId: CANVAS },
    );
    expect(okImg.ok).toBe(true);
    const img = snapshot.canvases[0]!.nodes.find((n) => n.kind === 'image-gen');
    expect((img?.data as { prompt?: string }).prompt).toBe('白底保温杯');
  });
});
