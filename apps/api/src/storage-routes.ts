import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { catalog } from '@selfhost/catalog';
import {
  LIBRARY_FOLDERS,
  deviceName,
  diskId,
  filesystemUuid,
  folderSubpath,
  libraryFolder,
  volumeLabel,
  type ConfirmIssueResult,
  type DiskListResult,
  type FolderUsageResult,
  type LibraryFolder,
  type ServiceName,
  type SmartResult,
  type StorageJob,
  type StorageSnapshot,
} from '@selfhost/shared';
import { AgentRequestError, type AgentClient } from './agent-client';
import type { AuditLog } from './audit';
import { REAUTH_AFTER_MS } from './auth';
import type { StatusMonitor } from './monitor';

const LONG_TIMEOUT_MS = 6 * 60 * 60_000;

export interface StorageRouteDeps {
  agent: AgentClient;
  audit: AuditLog;
  monitor: StatusMonitor;
  now: () => number;
  sendError: (
    reply: FastifyReply,
    status: number,
    error: string,
    message: string,
    extra?: object,
  ) => unknown;
}

const mountBody = z.object({ label: volumeLabel });
const unmountBody = z.object({ stopServices: z.boolean().default(false) });
const formatBody = z.object({
  diskId,
  label: volumeLabel,
  confirmName: z.string().max(32),
});
const assignBody = z.object({
  uuid: filesystemUuid,
  subpath: folderSubpath,
  copyExisting: z.boolean().default(false),
  stopServices: z.boolean().default(false),
});

// Agent messages for these codes are already plain English, so they are passed through.
const PASS_THROUGH = new Set(['refused', 'in_use', 'not_found', 'busy']);

export function registerStorageRoutes(secured: FastifyInstance, deps: StorageRouteDeps) {
  const { agent, audit, monitor, now, sendError } = deps;
  let job: StorageJob | null = null;

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AgentRequestError && PASS_THROUGH.has(error.code)) {
      return sendError(reply, error.code === 'not_found' ? 404 : 409, error.code, error.message);
    }
    if (error instanceof AgentRequestError && ['unreachable', 'timeout'].includes(error.code)) {
      return sendError(reply, 502, 'agent', 'The dashboard could not reach the server helper.');
    }
    return sendError(reply, 502, 'agent', 'That did not work. Check the drive and try again.');
  };

  const snapshot = async (): Promise<StorageSnapshot> => {
    const [list, folders] = await Promise.all([
      agent.call<DiskListResult>({ action: 'disk.list' }),
      Promise.all(
        LIBRARY_FOLDERS.map((folder) =>
          agent.call<FolderUsageResult>({ action: 'folder.usage', folder }),
        ),
      ),
    ]);
    return { disks: list.disks, missing: list.missing, folders, job };
  };

  // Services that use these folders and are not stopped. The agent refuses to change a drive under
  // a running service, so "stop them for me" is done here, through the same service actions.
  const servicesUsing = (folders: LibraryFolder[]): ServiceName[] => {
    const running = new Set(
      monitor
        .snapshot()
        .services.filter((s) => !['offline', 'not_installed'].includes(s.status))
        .map((s) => s.name),
    );
    return catalog
      .filter(
        (manifest) =>
          running.has(manifest.name) &&
          manifest.libraryFolders.some((entry) => folders.includes(entry.folder)),
      )
      .map((manifest) => manifest.name);
  };

  const stopAll = async (services: ServiceName[]) => {
    for (const service of services) {
      if (!monitor.beginAction(service, 'stopping')) {
        throw new AgentRequestError('busy', 'A service is busy right now. Try again in a moment.');
      }
      try {
        await agent.call({ action: 'service.stop', service }, { timeoutMs: 5 * 60_000 });
        await monitor.endAction(service);
      } catch (error) {
        await monitor.endAction(service);
        throw error;
      }
    }
  };

  const startAll = async (services: ServiceName[]) => {
    for (const service of services) {
      if (!monitor.beginAction(service, 'starting')) continue;
      try {
        await agent.call({ action: 'service.start', service }, { timeoutMs: 5 * 60_000 });
        await monitor.endAction(service);
      } catch {
        await monitor.endAction(service, 'It did not start again after the drive change.');
      }
    }
  };

  const foldersOnDrive = async (uuid: string): Promise<LibraryFolder[]> => {
    const { disks, folders } = await snapshot();
    const label = disks.flatMap((d) => d.volumes).find((v) => v.uuid === uuid)?.mountLabel;
    return label ? folders.filter((f) => f.mapped?.mountLabel === label).map((f) => f.folder) : [];
  };

  const recentlySignedIn = (request: FastifyRequest) => {
    const session = request.session as NonNullable<FastifyRequest['session']>;
    return now() - session.lastAuthAt <= REAUTH_AFTER_MS;
  };

  secured.get('/api/storage', async (_request, reply) => {
    try {
      return await snapshot();
    } catch (error) {
      return fail(reply, error);
    }
  });

  secured.get('/api/disks/:uuid/smart', async (request, reply) => {
    const uuid = filesystemUuid.safeParse((request.params as { uuid?: string }).uuid);
    if (!uuid.success) return sendError(reply, 404, 'not_found', 'That drive was not found.');
    try {
      return await agent.call<SmartResult>({ action: 'disk.smart', uuid: uuid.data });
    } catch (error) {
      return fail(reply, error);
    }
  });

  secured.post('/api/disks/:uuid/mount', async (request, reply) => {
    const uuid = filesystemUuid.safeParse((request.params as { uuid?: string }).uuid);
    const body = mountBody.safeParse(request.body);
    if (!uuid.success || !body.success) {
      return sendError(
        reply,
        400,
        'invalid_input',
        'Use a short name with lowercase letters, numbers and dashes, starting with a letter.',
      );
    }
    try {
      await agent.call({ action: 'disk.mount', uuid: uuid.data, label: body.data.label });
      audit.record({ actor: 'admin', event: 'disk.mount', target: uuid.data, outcome: 'ok' });
      return { ok: true };
    } catch (error) {
      audit.record({
        actor: 'admin',
        event: 'disk.mount',
        target: uuid.data,
        outcome: 'failed',
        detail: error instanceof AgentRequestError ? error.code : 'error',
      });
      return fail(reply, error);
    }
  });

  secured.post('/api/disks/:uuid/unmount', async (request, reply) => {
    const uuid = filesystemUuid.safeParse((request.params as { uuid?: string }).uuid);
    const body = unmountBody.safeParse(request.body ?? {});
    if (!uuid.success || !body.success) {
      return sendError(reply, 400, 'invalid_input', 'Something is missing from that request.');
    }
    try {
      if (body.data.stopServices) {
        await stopAll(servicesUsing(await foldersOnDrive(uuid.data)));
      }
      await agent.call({ action: 'disk.unmount', uuid: uuid.data }, { timeoutMs: 2 * 60_000 });
      audit.record({ actor: 'admin', event: 'disk.unmount', target: uuid.data, outcome: 'ok' });
      return { ok: true };
    } catch (error) {
      audit.record({
        actor: 'admin',
        event: 'disk.unmount',
        target: uuid.data,
        outcome: 'failed',
        detail: error instanceof AgentRequestError ? error.code : 'error',
      });
      return fail(reply, error);
    }
  });

  // Erasing a disk is the most destructive thing the dashboard can do, so it needs a recent
  // password, the disk's name typed out, and an agent confirm token on top.
  secured.post('/api/disks/by-device/:device/format', async (request, reply) => {
    const device = deviceName.safeParse((request.params as { device?: string }).device);
    const body = formatBody.safeParse(request.body);
    if (!device.success || !body.success) {
      return sendError(reply, 400, 'invalid_input', 'Something is missing from that request.');
    }
    if (!recentlySignedIn(request)) {
      return sendError(reply, 403, 'reauth_required', 'Enter your password to continue.');
    }
    if (body.data.confirmName !== device.data) {
      return sendError(
        reply,
        400,
        'confirmation_mismatch',
        `Type "${device.data}" to confirm erasing this drive.`,
      );
    }
    if (job?.state === 'running') {
      return sendError(reply, 409, 'busy', 'Another drive change is still running.');
    }

    job = { kind: 'formatting', target: device.data, state: 'running', message: null };
    const { label, diskId: chosen } = body.data;
    void (async () => {
      try {
        const confirm = (
          await agent.call<ConfirmIssueResult>({
            action: 'confirm.issue',
            kind: 'disk.format',
            target: device.data,
          })
        ).token;
        await agent.call(
          { action: 'disk.format', device: device.data, diskId: chosen, label, confirm },
          { timeoutMs: LONG_TIMEOUT_MS },
        );
        audit.record({ actor: 'admin', event: 'disk.format', target: device.data, outcome: 'ok' });
        job = null;
      } catch (error) {
        audit.record({
          actor: 'admin',
          event: 'disk.format',
          target: device.data,
          outcome: 'failed',
          detail: error instanceof AgentRequestError ? error.code : 'error',
        });
        job = {
          kind: 'formatting',
          target: device.data,
          state: 'failed',
          message:
            error instanceof AgentRequestError && PASS_THROUGH.has(error.code)
              ? error.message
              : 'The drive could not be prepared. Nothing was mounted.',
        };
      }
    })();
    return reply.code(202).send({ started: true });
  });

  secured.post('/api/storage/job/dismiss', async () => {
    if (job?.state === 'failed') job = null;
    return { ok: true };
  });

  secured.post('/api/folders/:folder/assign', async (request, reply) => {
    const folder = libraryFolder.safeParse((request.params as { folder?: string }).folder);
    const body = assignBody.safeParse(request.body);
    if (!folder.success || !body.success) {
      return sendError(
        reply,
        400,
        'invalid_input',
        'Choose a folder name without special symbols.',
      );
    }
    if (job?.state === 'running') {
      return sendError(reply, 409, 'busy', 'Another drive change is still running.');
    }

    const { uuid, subpath, copyExisting, stopServices } = body.data;
    const target = folder.data;
    job = { kind: 'copying', target, state: 'running', message: null };
    void (async () => {
      let stopped: ServiceName[] = [];
      try {
        if (stopServices) {
          stopped = servicesUsing([target]);
          await stopAll(stopped);
        }
        await agent.call(
          { action: 'folder.assign', folder: target, uuid, subpath, copyExisting },
          { timeoutMs: LONG_TIMEOUT_MS },
        );
        audit.record({ actor: 'admin', event: 'folder.assign', target, outcome: 'ok' });
        job = null;
      } catch (error) {
        audit.record({
          actor: 'admin',
          event: 'folder.assign',
          target,
          outcome: 'failed',
          detail: error instanceof AgentRequestError ? error.code : 'error',
        });
        job = {
          kind: 'copying',
          target,
          state: 'failed',
          message:
            error instanceof AgentRequestError && PASS_THROUGH.has(error.code)
              ? error.message
              : 'The folder could not be moved to the drive.',
        };
      }
      await startAll(stopped);
    })();
    return reply.code(202).send({ started: true });
  });
}
