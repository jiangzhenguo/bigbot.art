import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let chatId = 1;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (!msg.method && msg.id === 99) {
    process.stdout.write(JSON.stringify({ id: chatId, result: { reply: '工具完成', toolCalls: [] } }) + '\n');
    return;
  }
  if (msg.method !== 'chat') return;
  chatId = msg.id;
  process.stdout.write(JSON.stringify({
    id: 99,
    method: 'tool',
    params: {
      tool: 'canvas.list_nodes',
      args: {},
      projectId: msg.params.projectId,
      canvasId: msg.params.canvasId,
      threadId: msg.params.threadId,
    },
  }) + '\n');
});
