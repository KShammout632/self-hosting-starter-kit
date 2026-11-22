import { z } from 'zod';
import {
  confirmKind,
  confirmTarget,
  confirmToken,
  filesystemUuid,
  folderSubpath,
  kitVersion,
  libraryFolder,
  logTail,
  requestId,
  serviceName,
  snapshotId,
  tailscaleHostname,
  volumeLabel,
  type ConfirmKind,
} from './primitives';

const action = <A extends string, S extends z.ZodRawShape>(name: A, shape: S) =>
  z.object({ id: requestId, action: z.literal(name), ...shape }).strict();

const service = { service: serviceName };

export const agentRequest = z.discriminatedUnion('action', [
  action('service.install', service),
  action('service.uninstall', {
    ...service,
    deleteData: z.boolean(),
    confirm: confirmToken.optional(),
  }),
  action('service.start', service),
  action('service.stop', service),
  action('service.restart', service),
  action('service.update', service),
  action('service.status', service),

  action('logs.stream', { ...service, tail: logTail, follow: z.boolean().default(false) }),
  action('logs.download', service),

  action('disk.list', {}),
  action('disk.mount', { uuid: filesystemUuid, label: volumeLabel }),
  action('disk.unmount', { uuid: filesystemUuid }),
  action('disk.format', {
    uuid: filesystemUuid,
    label: volumeLabel,
    confirm: confirmToken.optional(),
  }),
  action('disk.smart', { uuid: filesystemUuid }),

  action('folder.assign', { folder: libraryFolder, uuid: filesystemUuid, subpath: folderSubpath }),
  action('folder.usage', { folder: libraryFolder }),

  action('tailscale.status', {}),
  action('tailscale.login', { hostname: tailscaleHostname }),
  action('tailscale.logout', {}),
  action('tailscale.serve.apply', {}),

  action('system.info', {}),
  action('system.reboot', {}),
  action('system.updates.check', {}),
  action('system.updates.apply', {}),

  action('snapshot.create', service),
  action('snapshot.restore', { ...service, snapshot: snapshotId }),

  action('confirm.issue', { kind: confirmKind, target: confirmTarget }),

  action('agent.version', {}),
  action('kit.update', { version: kitVersion }),
]);

export type AgentRequest = z.infer<typeof agentRequest>;
export type AgentAction = AgentRequest['action'];

export const AGENT_ACTIONS: readonly AgentAction[] = agentRequest.options.map(
  (option) => option.shape.action.value,
);

// Actions that change a service and therefore take its per-service lock.
const SERVICE_LOCKED_ACTIONS: ReadonlySet<AgentAction> = new Set([
  'service.install',
  'service.uninstall',
  'service.start',
  'service.stop',
  'service.restart',
  'service.update',
  'snapshot.create',
  'snapshot.restore',
]);

export function serviceLockKey(request: AgentRequest): ServiceLockKey | null {
  return SERVICE_LOCKED_ACTIONS.has(request.action) && 'service' in request
    ? request.service
    : null;
}
type ServiceLockKey = z.infer<typeof serviceName>;

export interface ConfirmBinding {
  kind: ConfirmKind;
  target: string;
}

// A confirm token is only good for the one action and target it was issued for.
export function confirmBinding(request: AgentRequest): ConfirmBinding | null {
  if (request.action === 'disk.format') return { kind: 'disk.format', target: request.uuid };
  if (request.action === 'service.uninstall' && request.deleteData) {
    return { kind: 'service.uninstall', target: request.service };
  }
  return null;
}

// Destructive actions must carry a confirm token. The agent rejects them without a valid one.
export function requiresConfirmToken(request: AgentRequest): boolean {
  return confirmBinding(request) !== null;
}
