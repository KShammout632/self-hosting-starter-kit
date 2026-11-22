export interface ApiConfig {
  port: number;
  host: string;
  dbPath: string;
  agentSocket: string;
  setupCodeFile: string;
  webDir: string | null;
}

export function parseConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is not valid.');
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.SELFHOST_DB ?? '/var/lib/selfhost/selfhost.db',
    agentSocket: env.SELFHOST_AGENT_SOCKET ?? '/run/selfhost/agent.sock',
    setupCodeFile: env.SELFHOST_SETUP_CODE_FILE ?? '/var/lib/selfhost/setup-code',
    webDir: env.SELFHOST_WEB_DIR ?? null,
  };
}
