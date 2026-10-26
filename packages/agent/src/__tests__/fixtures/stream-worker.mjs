import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method !== 'chat') return;
  let seq = 0;
  const emit = (event) => {
    process.stdout.write(JSON.stringify({
      method: 'stream',
      requestId: req.id,
      params: {
        ...event,
        seq: ++seq,
        projectId: req.params.projectId,
        canvasId: req.params.canvasId,
        threadId: req.params.threadId,
      },
    }) + '\n');
  };
  emit({ kind: 'round-start', round: 0 });
  emit({ kind: 'thinking-delta', round: 0, contentIndex: 0, delta: '分析' });
  emit({ kind: 'text-delta', round: 0, contentIndex: 1, delta: '你' });
  emit({ kind: 'text-delta', round: 0, contentIndex: 1, delta: '好' });
  // 留出断言窗口:delta 到达时 chat Promise 必须仍未 resolve。
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      id: req.id,
      result: { reply: '你好', thinking: '分析', toolCalls: [] },
    }) + '\n');
  }, 30);
});
