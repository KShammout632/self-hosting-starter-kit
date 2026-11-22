// Sends status requests to a running agent and checks the replies.
// Usage: node check-agent.mjs <socket-path> [--dry-run]
import net from 'node:net';

const [socketPath, flag] = process.argv.slice(2);
const dryRun = flag === '--dry-run';
if (!socketPath) {
  console.error('Usage: node check-agent.mjs <socket-path> [--dry-run]');
  process.exit(2);
}

function ask(request) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let received = '';
    client.setEncoding('utf8');
    client.on('error', reject);
    client.on('data', (data) => {
      received += data;
      if (received.includes('\n')) {
        client.destroy();
        resolve(JSON.parse(received.split('\n')[0]));
      }
    });
    client.write(JSON.stringify(request) + '\n');
  });
}

const checks = [
  [
    'agent.version',
    { id: 'v1', action: 'agent.version' },
    (r) => r.ok && typeof r.data.version === 'string' && r.data.dryRun === dryRun,
  ],
  [
    'system.info',
    { id: 's1', action: 'system.info' },
    (r) => r.ok && r.data.cpuCount > 0 && r.data.memTotalBytes > 0,
  ],
  [
    'service.status',
    { id: 'j1', action: 'service.status', service: 'jellyfin' },
    (r) => r.ok && r.data.service === 'jellyfin' && typeof r.data.state === 'string',
  ],
  [
    'tailscale.status',
    { id: 't1', action: 'tailscale.status' },
    (r) => r.ok && typeof r.data.installed === 'boolean',
  ],
  [
    'unknown action is refused',
    { id: 'x1', action: 'shell.exec', command: 'id' },
    (r) => !r.ok && r.error.code === 'unknown_action',
  ],
];

let failed = false;
for (const [name, request, passes] of checks) {
  let reply;
  try {
    reply = await ask(request);
  } catch (error) {
    reply = { error: String(error) };
  }
  const ok = passes(reply);
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(reply)}`);
}
process.exit(failed ? 1 : 0);
