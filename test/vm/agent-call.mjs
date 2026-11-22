// Sends one request to the running agent and prints the reply as JSON, for the gate scripts.
// Usage: node agent-call.mjs '{"action":"disk.list"}' [socket-path]
import net from 'node:net';

const [json, socketPath = '/run/selfhost/agent.sock'] = process.argv.slice(2);
if (!json) {
  console.error('Usage: node agent-call.mjs <request json> [socket-path]');
  process.exit(2);
}

const client = net.connect(socketPath);
let received = '';
client.setEncoding('utf8');
client.on('error', (error) => {
  console.error(String(error));
  process.exit(1);
});
client.on('data', (data) => {
  received += data;
  if (received.includes('\n')) {
    client.destroy();
    process.stdout.write(received.split('\n')[0] + '\n');
  }
});
client.write(JSON.stringify({ id: 'gate', ...JSON.parse(json) }) + '\n');
