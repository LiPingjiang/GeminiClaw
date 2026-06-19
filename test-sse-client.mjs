import { streamChat } from './dist/cli/tui/sse-client.js';

console.log('Testing SSE client...');

let deltaCount = 0;
let deltaContent = '';

const cancel = streamChat({
  baseUrl: 'http://127.0.0.1:18888',
  message: '在么？',
  authToken: 'gemeniclaw-local-dev-token-2026',
  onEvent: (event) => {
    if (event.kind === 'delta') {
      deltaCount++;
      deltaContent += event.content;
      console.log('  delta:', JSON.stringify(event.content));
    } else if (event.kind === 'turn_end') {
      console.log('  turn_end, toolCallCount:', event.toolCallCount);
    } else if (event.kind === 'agent_end') {
      console.log('  agent_end, model:', event.model, 'usage:', event.usage);
    } else if (event.kind === 'turn_start') {
      console.log('  turn_start');
    } else if (event.kind === 'error') {
      console.log('  error:', event.message);
    } else {
      console.log('  event:', event.kind);
    }
  },
  onSessionId: (sid) => console.log('SESSION:', sid),
  onDone: () => {
    console.log('DONE');
    console.log('Total deltas:', deltaCount, 'Content:', deltaContent);
    process.exit(0);
  },
  onError: (err) => {
    console.log('ERROR:', err.message);
    process.exit(1);
  },
});

setTimeout(() => {
  console.log('TIMEOUT');
  console.log('Total deltas:', deltaCount, 'Content:', deltaContent);
  cancel();
  process.exit(0);
}, 15000);
