import { describe, expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { buildCursorPrompt, CursorReplyTextStream, parseCursorReply, toCursorAssistantMessage } from '../cursor-cli.js';

describe('Cursor CLI 协议适配', () => {
  it('携带系统指令、工具定义和完整消息，并要求只读 JSON 输出', () => {
    const prompt = buildCursorPrompt({
      systemPrompt: '画布规则',
      tools: [{ name: 'canvas.list_nodes', description: '列节点', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: '看看画布', timestamp: 1 }],
    } as unknown as Context);
    expect(prompt).toContain('画布规则');
    expect(prompt).toContain('canvas.list_nodes');
    expect(prompt).toContain('看看画布');
    expect(prompt).toContain('禁止调用 Cursor 自带的任何工具');
  });

  it('还原最终文本', () => {
    expect(parseCursorReply('{"text":"已完成","toolCalls":[]}')).toEqual({ text: '已完成', toolCalls: [] });
  });

  it('还原工具调用并容忍 JSON 代码围栏', () => {
    const message = toCursorAssistantMessage('```json\n{"text":"先查画布","toolCalls":[{"name":"canvas.list_nodes","arguments":{}}]}\n```');
    expect(message.content).toEqual([
      { type: 'text', text: '先查画布' },
      expect.objectContaining({ type: 'toolCall', name: 'canvas.list_nodes', arguments: {} }),
    ]);
  });

  it('从说明文字 + 协议 JSON 的混合输出中提取文本和工具，不显示原始 JSON', () => {
    const protocol = JSON.stringify({
      text: '正在改写成 5 镜 × 4 秒的可用分镜表。',
      toolCalls: [{
        name: 'canvas.update_node',
        arguments: { nodeId: 'sb-1', data: { markdown: '# 分镜表\n\n| 镜号 | 画面 |\n| 1 | 示例 {保留花括号} |' } },
      }],
    });
    const message = toCursorAssistantMessage(`分镜表是模板回退的乱表，正在直接改写。${protocol}`);
    expect(message.content[0]).toEqual({ type: 'text', text: '正在改写成 5 镜 × 4 秒的可用分镜表。' });
    expect(message.content[1]).toEqual(expect.objectContaining({ type: 'toolCall', name: 'canvas.update_node' }));
    expect(JSON.stringify(message.content)).not.toContain('"toolCalls"');
  });

  it('兼容字符串化 arguments，但拒绝非对象参数', () => {
    expect(parseCursorReply('{"toolCalls":[{"name":"canvas.get_node","arguments":"{\\"nodeId\\":\\"n1\\"}"}]}').toolCalls[0])
      .toEqual({ name: 'canvas.get_node', arguments: { nodeId: 'n1' } });
    expect(() => parseCursorReply('{"toolCalls":[{"name":"canvas.get_node","arguments":"[]"}]}'))
      .toThrow('arguments 字符串必须解析为 JSON 对象');
  });

  it('模型未遵守 JSON 时保留真实文本，不伪造工具调用', () => {
    expect(parseCursorReply('我还需要确认')).toEqual({ text: '我还需要确认', toolCalls: [] });
  });

  it('空 JSON 回复明确失败，不静默收尾', () => {
    expect(() => parseCursorReply('{"text":"","toolCalls":[]}')).toThrow('既没有文本也没有工具调用');
  });
});

describe('Cursor 流式文本提取', () => {
  it('跨 chunk 解码 text，不泄漏协议 JSON', () => {
    const stream = new CursorReplyTextStream();
    expect(stream.push('{"toolCalls":[],"text":"你')).toBe('你');
    expect(stream.push('好\\n世')).toBe('好\n世');
    expect(stream.push('界"}')).toBe('界');
    expect(stream.push('')).toBe('');
  });

  it('等待 unicode 转义完整后再输出', () => {
    const stream = new CursorReplyTextStream();
    expect(stream.push('{"text":"\\u4f')).toBe('');
    expect(stream.push('60\\u597d"}')).toBe('你好');
  });
});
