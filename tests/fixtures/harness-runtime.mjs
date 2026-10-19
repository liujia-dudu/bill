import { createInterface } from 'node:readline';

// Protocol-only fixture: no model, browser or application credentials.
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  let result;
  switch (request.method) {
    case 'initialize':
      result = { serverInfo: { name: 'synthetic-harness', version: 'test' } };
      break;
    case 'session/working-directory/get':
      result = { cwd: process.cwd() };
      break;
    case 'shutdown':
      result = {};
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Unsupported fixture method' },
        }) + '\n',
      );
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
