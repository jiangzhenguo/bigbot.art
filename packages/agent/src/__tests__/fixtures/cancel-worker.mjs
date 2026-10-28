import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let seq = 0;

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'chat') {
    const stream = (event) => {
      process.stdout.write(JSON.stringify({
        method: 'stream', requestId: req.id,
        params: { ...event, seq: ++seq, projectId: req.params.projectId, canvasId: req.params.canvasId, threadId: req.params.threadId },
      }) + '\n');
    };
    stream({ kind: 'round-start', round: 0 });
    // 故意不结束 chat,也不响应后续 cancel:模拟 provider/worker 不配合的真实卡死。
    setTimeout(() => {
      stream({ kind: 'text-delta', round: 0, contentIndex: 0, delta: '取消后不应再出现' });
      process.stdout.write(JSON.stringify({
        id: 99, method: 'tool',
        params: { tool: 'canvas.list_nodes', args: {}, projectId: req.params.projectId, canvasId: req.params.canvasId, threadId: req.params.threadId },
      }) + '\n');
    }, 120);
    return;
  }
  if (req.method === 'cancel') {
    // 故意静默:取消是否即时生效不能依赖 worker 自觉。
    return;
  }
});
