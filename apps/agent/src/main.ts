import { parseConfig } from './config';
import { createDispatcher } from './dispatch';
import { createDockerClient, createFixtureDockerClient } from './docker';
import { dryRunRunner, run } from './exec';
import { handlers } from './handlers';
import { createAgentServer } from './server';
import { listenOnSocket } from './socket';

async function main() {
  const config = parseConfig(process.argv.slice(2), process.env);

  const dispatch = createDispatcher({
    handlers,
    deps: {
      dryRun: config.dryRun,
      docker: config.dryRun ? createFixtureDockerClient() : createDockerClient(),
      run: config.dryRun ? dryRunRunner : run,
    },
  });

  const server = createAgentServer(dispatch);
  await listenOnSocket(server, config.socketPath, config.dryRun ? null : 'selfhost');
  console.error(
    JSON.stringify({ event: 'listening', socket: config.socketPath, dryRun: config.dryRun }),
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'fatal', message: String(error) }));
  process.exit(1);
});
