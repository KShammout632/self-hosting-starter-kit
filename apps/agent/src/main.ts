import { parseConfig } from './config';
import { createDispatcher } from './dispatch';
import { createDockerClient, createFixtureDockerClient } from './docker';
import { createConfirmTokens } from './confirm';
import { dryRunHttpCheck, dryRunRunner, dryRunStreamer, httpCheck, run, streamLines } from './exec';
import { handlers } from './handlers';
import { DEFAULT_PATHS, dryRunFs, realFs } from './host';
import { createAgentServer } from './server';
import { listenOnSocket } from './socket';

declare const __TEST_BUILD__: boolean | undefined;

async function main() {
  const testBuild = typeof __TEST_BUILD__ !== 'undefined' && __TEST_BUILD__;
  const config = parseConfig(process.argv.slice(2), process.env, testBuild);

  const dispatch = createDispatcher({
    handlers,
    deps: {
      dryRun: config.dryRun,
      docker: config.dryRun ? createFixtureDockerClient() : createDockerClient(),
      run: config.dryRun ? dryRunRunner : run,
      paths: DEFAULT_PATHS,
      fs: config.dryRun ? dryRunFs : realFs,
      stream: config.dryRun ? dryRunStreamer : streamLines,
      httpCheck: config.dryRun ? dryRunHttpCheck : httpCheck,
      confirmTokens: createConfirmTokens(),
      ...(config.releaseBase ? { releaseBase: config.releaseBase } : {}),
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
