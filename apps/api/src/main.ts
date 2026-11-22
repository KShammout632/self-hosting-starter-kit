import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createAgentClient } from './agent-client';
import { buildApp } from './app';
import { createAuditLog } from './audit';
import { createAuth, sha256 } from './auth';
import { parseConfig } from './config';
import { openDb } from './db';
import { createStatusMonitor } from './monitor';

async function main() {
  const config = parseConfig(process.env);
  const db = openDb(config.dbPath);
  const auth = createAuth({ db, setupCodeFile: config.setupCodeFile });

  // The installer normally writes the setup code. This covers a missing file, so a server that
  // lost it can still be set up from the code in this log.
  if (!auth.hasAdmin() && !existsSync(config.setupCodeFile)) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
    writeFileSync(config.setupCodeFile, sha256(code) + '\n', { mode: 0o640 });
    console.error(
      JSON.stringify({ event: 'setup-code', code: `${code.slice(0, 4)}-${code.slice(4)}` }),
    );
  }

  const agent = createAgentClient(config.agentSocket);
  const monitor = createStatusMonitor({ agent });
  const app = await buildApp({
    agent,
    auth,
    audit: createAuditLog(db),
    monitor,
    webDir: config.webDir,
    logger: true,
  });

  monitor.start();
  await app.listen({ port: config.port, host: config.host });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      monitor.stop();
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'fatal', message: String(error) }));
  process.exit(1);
});
