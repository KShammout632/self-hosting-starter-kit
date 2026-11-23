import { z } from 'zod';
import { libraryFolder, serviceName } from './primitives';

export const agentVersionResult = z.object({
  version: z.string(),
  dryRun: z.boolean(),
});
export type AgentVersionResult = z.infer<typeof agentVersionResult>;

export const containerSummary = z.object({
  name: z.string(),
  state: z.string(),
  health: z.enum(['healthy', 'unhealthy', 'starting']).nullable(),
  startedAt: z.string().nullable(),
});
export type ContainerSummary = z.infer<typeof containerSummary>;

export const SERVICE_STATES = ['not_found', 'running', 'stopped', 'partial', 'restarting'] as const;

export const serviceStatusResult = z.object({
  service: serviceName,
  state: z.enum(SERVICE_STATES),
  containers: z.array(containerSummary),
  // The agent checks the service's health URL on the host. Null when the containers are not all running.
  http: z.object({ ok: z.boolean() }).nullable(),
  // Library folders this service needs whose drive is not mounted right now.
  missingFolders: z.array(libraryFolder),
  // True while the owner has not yet been shown this service's one-time login details.
  credentialsPending: z.boolean(),
});
export type ServiceStatusResult = z.infer<typeof serviceStatusResult>;

export const serviceCredentialsResult = z.object({
  credentials: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type ServiceCredentialsResult = z.infer<typeof serviceCredentialsResult>;

export const systemInfoResult = z.object({
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuCount: z.number().int(),
  memTotalBytes: z.number(),
  memFreeBytes: z.number(),
  uptimeSeconds: z.number(),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  cpuLoadPercent: z.number(),
  diskTotalBytes: z.number(),
  diskFreeBytes: z.number(),
  temperatureCelsius: z.number().nullable(),
});
export type SystemInfoResult = z.infer<typeof systemInfoResult>;

export const tailscaleStatusResult = z.object({
  installed: z.boolean(),
  backendState: z.string().nullable(),
  hostname: z.string().nullable(),
  dnsName: z.string().nullable(),
  // The page the owner opens to sign this server in to Tailscale. Only present while it waits for that.
  authUrl: z.string().nullable(),
  // Both must be switched on in the Tailscale admin console before https addresses work.
  magicDnsEnabled: z.boolean(),
  httpsEnabled: z.boolean(),
});
export type TailscaleStatusResult = z.infer<typeof tailscaleStatusResult>;

export const remoteTarget = z.union([serviceName, z.literal('dashboard')]);
export type RemoteTarget = z.infer<typeof remoteTarget>;

export const tailscaleServeResult = z.object({
  urls: z.array(z.object({ target: remoteTarget, url: z.string() })),
});
export type TailscaleServeResult = z.infer<typeof tailscaleServeResult>;

export const confirmIssueResult = z.object({ token: z.string(), expiresInSeconds: z.number() });
export type ConfirmIssueResult = z.infer<typeof confirmIssueResult>;

export const DISK_FILESYSTEMS = ['ext4', 'ntfs', 'exfat'] as const;

export const volumeInfo = z.object({
  partition: z.string(),
  uuid: z.string(),
  fsLabel: z.string().nullable(),
  filesystem: z.string().nullable(),
  sizeBytes: z.number(),
  usedBytes: z.number().nullable(),
  freeBytes: z.number().nullable(),
  // The /mnt/<label> name once the kit has mounted it, null while it is not mounted.
  mountLabel: z.string().nullable(),
  mounted: z.boolean(),
  // True when the kit knows this drive (it has a mount unit) but it is not mounted right now.
  configured: z.boolean(),
  mountable: z.boolean(),
  keepsPermissions: z.boolean(),
  nearlyFull: z.boolean(),
});
export type VolumeInfo = z.infer<typeof volumeInfo>;

export const diskInfo = z.object({
  device: z.string(),
  model: z.string().nullable(),
  sizeBytes: z.number(),
  transport: z.string().nullable(),
  removable: z.boolean(),
  isSystem: z.boolean(),
  canFormat: z.boolean(),
  volumes: z.array(volumeInfo),
});
export type DiskInfo = z.infer<typeof diskInfo>;

// A drive the kit set up earlier that is not plugged in right now.
export const missingDrive = z.object({ uuid: z.string(), mountLabel: z.string() });
export type MissingDrive = z.infer<typeof missingDrive>;

export const diskListResult = z.object({
  disks: z.array(diskInfo),
  missing: z.array(missingDrive),
});
export type DiskListResult = z.infer<typeof diskListResult>;

export const diskFormatResult = z.object({ uuid: z.string(), label: z.string() });
export type DiskFormatResult = z.infer<typeof diskFormatResult>;

export const smartResult = z.object({
  supported: z.boolean(),
  passed: z.boolean().nullable(),
  temperatureCelsius: z.number().nullable(),
  reallocatedSectors: z.number().nullable(),
  powerOnHours: z.number().nullable(),
  warnings: z.array(z.string()),
});
export type SmartResult = z.infer<typeof smartResult>;

export const folderUsageResult = z.object({
  folder: libraryFolder,
  path: z.string(),
  mapped: z.object({ mountLabel: z.string(), subpath: z.string() }).nullable(),
  // The folder is mapped to a drive, but that drive is not mounted right now.
  volumeMissing: z.boolean(),
  hasLocalFiles: z.boolean(),
  usedBytes: z.number().nullable(),
  freeBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
  nearlyFull: z.boolean(),
});
export type FolderUsageResult = z.infer<typeof folderUsageResult>;
