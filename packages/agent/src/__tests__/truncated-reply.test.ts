/**
 * 输出截断(stop=length)收尾文案单测 — 「假成功」回归防护
 *
 * 真实事故(2026-09-28,项目 proj-1789363510085-tp83c 主画布):
 *   用户指令「将3d人物转化成真人的视频」。日志:
 *     [pi-chat] round=2 calls=canvas.update_node
 *     agent.tool ✕ canvas.update_node → data 是字符串但不是合法 JSON(position 552)
 *     [pi-chat] round=3 stop=length blocks=thinking err=
 *     [pi-chat] round=3 calls=(none)
 *     agent.chat 完成 · 工具 5 个 · 回复 0 字
 *
 *   根因:模型把含几千字 prompt 的 data **序列化成 JSON 字符串**输出时,12000 token 被烧光,
 *   JSON 在 552 字符处断成非法值;第 3 轮重试时 thinking 又用尽 token,连工具调用都没发出。
 *
 *   缺陷:原实现对 `stopReason === 'length'` **毫无处理** —— reply 为空、无工具调用时
 *   直接当作正常完成返回 → 用户看到静默的 0 字回复(「假成功」,
 *   与批次1 修的「假失败」是同一类问题的镜像)。
 *
 * 修复:截断时一律给出明确说明;有部分文本则保留但标注不完整。
 */
import { describe, it, expect } from 'vitest';
import { composeTruncatedReply } from '../pi-chat.js';

describe('composeTruncatedReply — 无文本(事故现场)', () => {
  it('空回复 → 给出解释而非空字符串(修复前这里直接返回 "")', () => {
    const msg = composeTruncatedReply('');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain('截断');
    expect(msg).toContain('token');
  });

  it('纯空白(reply 只有空格/换行)也按「无文本」处理', () => {
    for (const raw of ['   ', '\n\n', '\t', ' \n \t ']) {
      const msg = composeTruncatedReply(raw);
      expect(msg).toContain('未产生任何有效操作或回复');
      expect(msg.trim().length).toBeGreaterThan(0);
    }
  });

  it('文案要指出最常见原因(一次写入太长)并给可执行建议', () => {
    const msg = composeTruncatedReply('');
    expect(msg).toContain('太长');
    expect(msg).toContain('拆');
  });
});

describe('composeTruncatedReply — 有部分文本', () => {
  it('保留模型已产出的内容(不丢弃),并追加截断标注', () => {
    const partial = '我已经把镜头 03 的提示词改好了,内容如下:城邦联盟礼仪官…';
    const msg = composeTruncatedReply(partial);
    expect(msg).toContain(partial); // 内容保留
    expect(msg).toContain('截断');   // 但明确标注
    expect(msg).toContain('不完整');
  });

  it('标注追加在结尾(不破坏原文可读性)', () => {
    const msg = composeTruncatedReply('前半句');
    expect(msg.startsWith('前半句')).toBe(true);
    expect(msg.indexOf('截断')).toBeGreaterThan(msg.indexOf('前半句'));
  });

  it('两种情形的文案不同(无文本给建议,有文本只标注)', () => {
    expect(composeTruncatedReply('')).not.toBe(composeTruncatedReply('有内容'));
    expect(composeTruncatedReply('有内容')).not.toContain('建议:');
  });
});
