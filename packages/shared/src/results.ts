import { z } from 'zod';
import { serviceName } from './primitives';

export const agentVersionResult = z.object({
  version: z.string(),
  dryRun: z.boolean(),
});
export type AgentVersionResult = z.infer<typeof agentVersionResult>;

export const containerSummary = z.object({
  name: z.string(),
  state: z.string(),
  health: z.enum(['healthy', 'unhealthy', 'starting']).nullable(),
});
export type ContainerSummary = z.infer<typeof containerSummary>;

export const SERVICE_STATES = ['not_found', 'running', 'stopped', 'partial', 'restarting'] as const;

export const serviceStatusResult = z.object({
  service: serviceName,
  state: z.enum(SERVICE_STATES),
  containers: z.array(containerSummary),
});
export type ServiceStatusResult = z.infer<typeof serviceStatusResult>;

export const systemInfoResult = z.object({
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuCount: z.number().int(),
  memTotalBytes: z.number(),
  memFreeBytes: z.number(),
  uptimeSeconds: z.number(),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
});
export type SystemInfoResult = z.infer<typeof systemInfoResult>;

export const tailscaleStatusResult = z.object({
  installed: z.boolean(),
  backendState: z.string().nullable(),
  hostname: z.string().nullable(),
  dnsName: z.string().nullable(),
});
export type TailscaleStatusResult = z.infer<typeof tailscaleStatusResult>;
