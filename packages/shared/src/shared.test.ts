import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTIONS,
  parseRequest,
  requiresConfirmToken,
  serviceLockKey,
  agentRequest,
} from './index';

const parse = (value: unknown) => parseRequest(JSON.stringify(value));

describe('agent request schema', () => {
  it('accepts a valid request', () => {
    const result = parse({ id: 'a1', action: 'service.restart', service: 'jellyfin' });
    expect(result.ok).toBe(true);
  });

  it('lists every v1 action', () => {
    expect(AGENT_ACTIONS).toHaveLength(28);
    expect(new Set(AGENT_ACTIONS).size).toBe(AGENT_ACTIONS.length);
  });

  it('rejects unknown actions', () => {
    const result = parse({ id: 'a1', action: 'shell.exec', command: 'ls' });
    expect(result).toMatchObject({ ok: false, id: 'a1', code: 'unknown_action' });
  });

  it('rejects unknown services', () => {
    const result = parse({ id: 'a1', action: 'service.start', service: 'plex' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('rejects extra arguments', () => {
    const result = parse({ id: 'a1', action: 'service.start', service: 'jellyfin', cmd: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('rejects malformed JSON', () => {
    expect(parseRequest('{nope')).toMatchObject({ ok: false, id: null, code: 'invalid_json' });
  });

  it('rejects a missing or malformed id', () => {
    expect(parse({ action: 'agent.version' })).toMatchObject({ ok: false });
    expect(parse({ id: 'has spaces', action: 'agent.version' })).toMatchObject({ ok: false });
  });

  it('does not echo back an oversized id', () => {
    const result = parse({ id: 'x'.repeat(65), action: 'agent.version' });
    expect(result).toMatchObject({ ok: false, id: null });
  });

  it('bounds numbers', () => {
    const base = { id: 'a1', action: 'logs.stream', service: 'immich' };
    expect(parse({ ...base, tail: 500 }).ok).toBe(true);
    expect(parse({ ...base, tail: 0 }).ok).toBe(false);
    expect(parse({ ...base, tail: 5001 }).ok).toBe(false);
    expect(parse({ ...base, tail: 1.5 }).ok).toBe(false);
  });

  it('refuses path-like and shell-like strings', () => {
    const base = { id: 'a1', action: 'folder.assign', folder: 'movies', uuid: 'ABCD-1234' };
    expect(parse({ ...base, subpath: 'Movies/Action' }).ok).toBe(true);
    for (const subpath of ['../etc', '/etc/passwd', 'a/../b', 'a;rm -rf', '$(id)', 'a\nb', '']) {
      expect(parse({ ...base, subpath }).ok, subpath).toBe(false);
    }
    expect(parse({ id: 'a1', action: 'disk.mount', uuid: 'x; reboot', label: 'media1' }).ok).toBe(
      false,
    );
    expect(parse({ id: 'a1', action: 'disk.mount', uuid: 'ABCD-1234', label: '../x' }).ok).toBe(
      false,
    );
  });
});

describe('request helpers', () => {
  const request = (value: unknown) => agentRequest.parse(value);

  it('flags destructive actions that need a confirm token', () => {
    expect(
      requiresConfirmToken(
        request({ id: 'a', action: 'disk.format', uuid: 'ABCD-1234', label: 'media1' }),
      ),
    ).toBe(true);
    expect(
      requiresConfirmToken(
        request({ id: 'a', action: 'service.uninstall', service: 'immich', deleteData: true }),
      ),
    ).toBe(true);
    expect(
      requiresConfirmToken(
        request({ id: 'a', action: 'service.uninstall', service: 'immich', deleteData: false }),
      ),
    ).toBe(false);
  });

  it('locks only actions that change a service', () => {
    expect(serviceLockKey(request({ id: 'a', action: 'service.update', service: 'immich' }))).toBe(
      'immich',
    );
    expect(serviceLockKey(request({ id: 'a', action: 'service.status', service: 'immich' }))).toBe(
      null,
    );
    expect(serviceLockKey(request({ id: 'a', action: 'agent.version' }))).toBe(null);
  });
});
