import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@selfhost/shared';
import { CONFIRM_TTL_MS, createConfirmTokens } from './confirm';
import { createDispatcher } from './dispatch';
import { dryRunRunner, dryRunStreamer } from './exec';
import { handlers, type Deps } from './handlers';
import { DEFAULT_PATHS, dryRunFs } from './host';

const makeDeps = (confirmTokens = createConfirmTokens()): Deps => ({
  dryRun: true,
  docker: { listServiceContainers: async () => [] },
  run: dryRunRunner,
  paths: DEFAULT_PATHS,
  fs: dryRunFs,
  stream: dryRunStreamer,
  httpCheck: async () => true,
  confirmTokens,
});

async function ask(deps: Deps, request: Record<string, unknown>): Promise<AgentResponse[]> {
  const dispatch = createDispatcher({ handlers, deps, log: () => {} });
  const out: AgentResponse[] = [];
  for await (const message of dispatch(JSON.stringify({ id: 'r1', ...request }))) out.push(message);
  return out;
}

describe('confirm tokens', () => {
  it('are bound to one action and target, expire, and work once', () => {
    let now = 1_000;
    const tokens = createConfirmTokens(() => now);
    const token = tokens.issue('service.uninstall', 'jellyfin');

    expect(tokens.verify(token, 'service.uninstall', 'jellyfin')).toBe(true);
    expect(tokens.verify(token, 'service.uninstall', 'immich')).toBe(false);
    expect(tokens.verify(token, 'disk.format', 'jellyfin')).toBe(false);
    expect(tokens.verify('x'.repeat(43), 'service.uninstall', 'jellyfin')).toBe(false);

    tokens.consume(token);
    expect(tokens.verify(token, 'service.uninstall', 'jellyfin')).toBe(false);

    const later = tokens.issue('service.uninstall', 'jellyfin');
    now += CONFIRM_TTL_MS + 1;
    expect(tokens.verify(later, 'service.uninstall', 'jellyfin')).toBe(false);
  });

  it('are long enough for the request schema', () => {
    expect(createConfirmTokens().issue('disk.format', 'sdb')).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  });
});

describe('confirm.issue and destructive actions', () => {
  const uninstall = (confirm?: string, service = 'jellyfin') => ({
    action: 'service.uninstall',
    service,
    deleteData: true,
    confirm,
  });

  it('issues a token that lets one uninstall through, once', async () => {
    const deps = makeDeps();
    const [issued] = await ask(deps, {
      action: 'confirm.issue',
      kind: 'service.uninstall',
      target: 'jellyfin',
    });
    const token = (issued as { data: { token: string } }).data.token;

    const [first] = await ask(deps, uninstall(token));
    expect(first).not.toMatchObject({ error: { code: 'confirm_required' } });
    const [second] = await ask(deps, uninstall(token));
    expect(second).toMatchObject({ ok: false, error: { code: 'confirm_required' } });
  });

  it('rejects a token issued for a different service', async () => {
    const deps = makeDeps();
    const token = deps.confirmTokens.issue('service.uninstall', 'immich');
    const [reply] = await ask(deps, uninstall(token));
    expect(reply).toMatchObject({ ok: false, error: { code: 'confirm_required' } });
  });

  it('rejects made-up tokens', async () => {
    const [reply] = await ask(makeDeps(), uninstall('a'.repeat(43)));
    expect(reply).toMatchObject({ ok: false, error: { code: 'confirm_required' } });
  });

  it('refuses to issue a token for a target that does not match the kind', async () => {
    const [reply] = await ask(makeDeps(), {
      action: 'confirm.issue',
      kind: 'service.uninstall',
      target: 'not-a-service',
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});
