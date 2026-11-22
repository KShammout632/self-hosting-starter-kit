// The `selfhost` command line helper. It is a thin client for the host agent: it sends one request
// over the agent socket and prints the answer in plain English. All rules live in the agent.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';

const SOCKET_PATH = process.env.SELFHOST_AGENT_SOCKET ?? '/run/selfhost/agent.sock';
const SETUP_CODE_FILE = process.env.SELFHOST_SETUP_CODE_FILE ?? '/var/lib/selfhost/setup-code';
const SERVICES = {
  jellyfin: { name: 'Jellyfin', port: 8096 },
  navidrome: { name: 'Navidrome', port: 4533 },
  immich: { name: 'Immich', port: 2283 },
  nextcloud: { name: 'Nextcloud', port: 8081 },
};

const USAGE = `Usage: sudo selfhost <command> [service]

Commands:
  install <service>      Download and start a service
  start <service>        Start a stopped service
  stop <service>         Stop a service
  restart <service>      Restart a service
  update <service>       Move a service to the version this kit pins
  status [service]       Show whether services are running
  logs <service>         Show recent log lines (add --tail 200 for more)
  uninstall <service>    Remove a service but keep its settings (add --delete-data to erase them)
  reset-password         Get a new setup code to choose a new dashboard password
  version                Show the agent version

Services: ${Object.keys(SERVICES).join(', ')}`;

class UserError extends Error {}

function ask(request) {
  return new Promise((resolve, reject) => {
    const client = net.connect(SOCKET_PATH);
    const chunks = [];
    let buffer = '';
    client.setEncoding('utf8');
    client.on('error', (error) => {
      const refused = ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(error.code);
      reject(
        new UserError(
          refused
            ? 'Cannot reach the selfhost agent. Run this with sudo, and check that it is running: sudo systemctl status selfhost-agent'
            : String(error),
        ),
      );
    });
    client.on('data', (data) => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if ('chunk' in message) chunks.push(message.chunk);
        else {
          client.destroy();
          resolve({ message, chunks });
        }
      }
    });
    client.write(
      JSON.stringify({ id: `cli-${randomBytes(4).toString('hex')}`, ...request }) + '\n',
    );
  });
}

async function send(request) {
  const { message, chunks } = await ask(request);
  if (message.ok === false) throw new UserError(message.error.message);
  return { data: message.data, chunks };
}

function parseService(value) {
  if (!value || !(value in SERVICES)) {
    throw new UserError(`Choose a service: ${Object.keys(SERVICES).join(', ')}.`);
  }
  return value;
}

function lanAddress() {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    // Skip Tailscale and Docker's own networks: the point is the address used at home.
    if (/^(tailscale|docker|br-|veth)/.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return 'your-server-ip';
}

const STATE_TEXT = {
  not_found: 'is not installed',
  running: 'is running',
  stopped: 'is stopped',
  partial: 'is only partly running',
  restarting: 'keeps restarting, which means something is wrong',
};

async function printStatus(service) {
  const { data } = await send({ action: 'service.status', service });
  const info = SERVICES[service];
  console.log(`${info.name} ${STATE_TEXT[data.state] ?? data.state}.`);
  if (data.state === 'running') console.log(`  Open it at http://${lanAddress()}:${info.port}`);
  return data.state;
}

function parseTail(args) {
  const index = args.indexOf('--tail');
  if (index === -1) return 100;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 5000) {
    throw new UserError('--tail needs a number from 1 to 5000.');
  }
  return value;
}

async function confirmDeletion(service) {
  if (!process.stdin.isTTY) {
    throw new UserError(
      'Deleting data needs you to type the service name, so run this in a terminal.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This permanently erases ${SERVICES[service].name}'s settings and database. Your media files are not touched.\nType "${service}" to continue: `,
  );
  rl.close();
  if (answer.trim() !== service) throw new UserError('Cancelled. Nothing was deleted.');
  const { data } = await send({
    action: 'confirm.issue',
    kind: 'service.uninstall',
    target: service,
  });
  return data.token;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const service = rest.find((arg) => !arg.startsWith('--') && arg !== String(parseTailValue(rest)));

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;

    case 'reset-password': {
      if (process.getuid?.() !== 0)
        throw new UserError('Run this with sudo: sudo selfhost reset-password');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
      writeFileSync(SETUP_CODE_FILE, createHash('sha256').update(code).digest('hex') + '\n', {
        mode: 0o640,
      });
      const id = (flag) => Number(execFileSync('id', [flag, 'selfhost'], { encoding: 'utf8' }));
      chownSync(SETUP_CODE_FILE, id('-u'), id('-g'));
      chmodSync(SETUP_CODE_FILE, 0o640);
      console.log(
        `Open http://${lanAddress()}:8080 and use this setup code to choose a new password:\n`,
      );
      console.log(`    ${code.slice(0, 4)}-${code.slice(4)}\n`);
      console.log('Everyone is signed out when the new password is saved.');
      return;
    }

    case 'version': {
      const { data } = await send({ action: 'agent.version' });
      console.log(`selfhost agent ${data.version}${data.dryRun ? ' (dry run)' : ''}`);
      return;
    }

    case 'install': {
      const name = parseService(service);
      console.log(
        `Installing ${SERVICES[name].name}. The first time this downloads the app, so it can take a few minutes...`,
      );
      await send({ action: 'service.install', service: name });
      console.log('Done.');
      await printStatus(name);
      return;
    }

    case 'start':
    case 'stop':
    case 'restart':
    case 'update': {
      const name = parseService(service);
      await send({ action: `service.${command}`, service: name });
      await printStatus(name);
      return;
    }

    case 'status': {
      if (service) await printStatus(parseService(service));
      else for (const name of Object.keys(SERVICES)) await printStatus(name);
      return;
    }

    case 'logs': {
      const name = parseService(service);
      const { chunks } = await send({
        action: 'logs.stream',
        service: name,
        tail: parseTail(rest),
      });
      for (const entry of chunks) console.log(entry.ts ? `${entry.ts} ${entry.line}` : entry.line);
      return;
    }

    case 'uninstall': {
      const name = parseService(service);
      const deleteData = rest.includes('--delete-data');
      const request = { action: 'service.uninstall', service: name, deleteData };
      if (deleteData) request.confirm = await confirmDeletion(name);
      await send(request);
      console.log(
        deleteData
          ? `${SERVICES[name].name} and its settings were removed.`
          : `${SERVICES[name].name} was removed. Its settings are kept, so installing it again picks up where you left off.`,
      );
      return;
    }

    default:
      throw new UserError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

function parseTailValue(args) {
  const index = args.indexOf('--tail');
  return index === -1 ? undefined : args[index + 1];
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof UserError ? error.message : `Something went wrong: ${error}`);
  process.exit(1);
});
