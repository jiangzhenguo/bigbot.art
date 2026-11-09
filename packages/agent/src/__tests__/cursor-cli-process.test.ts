import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { completeCursorCli } = await import('../cursor-cli.js');

function context(): Context {
  return {
    systemPrompt: 'sys', tools: [],
    messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  } as unknown as Context;
}

describe('Cursor CLI 进程桥', () => {
  beforeEach(() => spawnMock.mockReset());

  it('stream-json 实时转发解码文本，跳过重复事件并解析最终 result', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    let stdin = '';
    child.stdin.on('data', (chunk) => { stdin += String(chunk); });
    spawnMock.mockReturnValue(child);

    const deltas: string[] = [];
    const pending = completeCursorCli(context(), { model: 'composer-2.5', onTextDelta: (delta) => deltas.push(delta) });
    const assistant = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type: 'assistant', timestamp_ms: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
    });
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      assistant('{"text":"连接'),
      assistant('正常","toolCalls":[]}'),
      // 工具调用前 flush 与最终 flush 都是重复文本，不得再次推送。
      assistant('{"text":"连接正常","toolCalls":[]}', { model_call_id: 'm1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"text":"连接正常","toolCalls":[]}' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"text":"连接正常","toolCalls":[]}', session_id: 's1' }),
    ];
    // 特意跨 chunk 拆一行，覆盖行缓冲。
    child.stdout.write(`${lines[0]}\n${lines[1]}\n${lines[2]?.slice(0, 20)}`);
    child.stdout.end(`${lines[2]?.slice(20)}\n${lines.slice(3).join('\n')}\n`);
    child.emit('close', 0);

    const result = await pending;
    expect(result.content).toEqual([{ type: 'text', text: '连接正常' }]);
    expect(deltas.join('')).toBe('连接正常');
    expect(deltas.join('')).not.toContain('toolCalls');
    expect(stdin).toContain('hello');
    const [executable, args, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe('cursor-agent');
    expect(args).toEqual(expect.arrayContaining([
      '--print', '--mode', 'ask', '--output-format', 'stream-json', '--stream-partial-output', '--model', 'composer-2.5',
    ]));
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--approve-mcps');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('非零退出时返回 stderr 中的真实错误', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);

    const pending = completeCursorCli(context());
    child.stderr.end('Error: [unavailable] read ETIMEDOUT');
    child.emit('close', 1);
    await expect(pending).rejects.toThrow('read ETIMEDOUT');
  });
});
