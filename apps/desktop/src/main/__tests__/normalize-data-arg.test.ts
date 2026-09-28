/**
 * normalizeDataArg 单测 — 工具参数 `data` 的类型规整
 *
 * 背景(真实事故 2026-09-28 主画布对话):
 *   工具 schema 把 `data` 声明成 object,但本地小模型(Ornith)把它**序列化成 JSON 字符串**传:
 *     canvas.update_node({"nodeId":"new9-nhz9","data":"{\"prompt\": \"# Camera 运镜\\n..."})
 *   旧实现判 `typeof a.data === 'object'` → 字符串为 false → **整段 patch 被静默跳过**,
 *   函数却照常返回「✓ 已更新节点」。结果:模型写了几百字提示词,节点 prompt 长度仍为 0,
 *   直到 engine.submit 才在很远的地方炸 `h3: prompt must not be empty`。
 *
 * 这是最恶劣的一类 bug——「报告成功但什么都没做」。现在的语义:
 *   对象直接用 | 字符串尝试 JSON.parse | 解析失败**明确报错**(绝不静默放行)。
 */
import { describe, it, expect } from 'vitest';
import { normalizeDataArg } from '../tool-handlers';

describe('normalizeDataArg — 对象直通', () => {
  it('普通对象原样返回', () => {
    const r = normalizeDataArg({ prompt: 'hello' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ prompt: 'hello' });
  });

  it('undefined / null → 空对象(允许只改 label 这类无 data 的调用)', () => {
    for (const v of [undefined, null]) {
      const r = normalizeDataArg(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toEqual({});
    }
  });

  it('空字符串 → 空对象(等价于没传 data)', () => {
    const r = normalizeDataArg('   ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({});
  });
});

describe('normalizeDataArg — 字符串化 JSON(本次事故的核心场景)', () => {
  it('被序列化的对象字符串 → 解析成功(修复前这里会静默跳过)', () => {
    const r = normalizeDataArg('{"prompt":"半写实厚涂插画风"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ prompt: '半写实厚涂插画风' });
  });

  it('带换行与转义的提示词(贴近事故现场的真实形态)', () => {
    const payload = JSON.stringify({ prompt: '# Camera 运镜\nStatic medium shot, gently pushing in.' });
    const r = normalizeDataArg(payload);
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.data.prompt)).toContain('# Camera 运镜');
  });

  it('嵌套对象(accel)也能解析', () => {
    const r = normalizeDataArg('{"accel":{"enabled":true,"packId":"p1","steps":8}}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ accel: { enabled: true, packId: 'p1', steps: 8 } });
  });

  it('前后有空白也能解析(模型常带缩进)', () => {
    const r = normalizeDataArg('  \n {"prompt":"x"} \n ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ prompt: 'x' });
  });
});

describe('normalizeDataArg — 非法输入必须明确报错(绝不假成功)', () => {
  it('不是合法 JSON → 报错,且提示不要用字符串包裹', () => {
    const r = normalizeDataArg('{"prompt": 未加引号的乱码}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('不是合法 JSON');
      expect(r.error).toContain('不要用字符串包裹');
    }
  });

  it('纯文案字符串(未序列化)→ 报错而非当成 prompt 猜', () => {
    const r = normalizeDataArg('给我写个提示词');
    expect(r.ok).toBe(false);
  });

  it('JSON 但解析成数组 → 报错并说明收到数组', () => {
    const r = normalizeDataArg('[1,2,3]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('数组');
  });

  it('JSON 但解析成标量 → 报错', () => {
    for (const s of ['"just a string"', '42', 'true', 'null']) {
      const r = normalizeDataArg(s);
      expect(r.ok, s).toBe(false);
    }
  });

  it('数组对象 → 报错(不接受数组当 data)', () => {
    const r = normalizeDataArg([{ prompt: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('数组');
  });

  it('数字/布尔 → 报错', () => {
    expect(normalizeDataArg(42).ok).toBe(false);
    expect(normalizeDataArg(true).ok).toBe(false);
  });
});
