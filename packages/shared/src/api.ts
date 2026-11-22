import type {
  DiskInfo,
  FolderUsageResult,
  MissingDrive,
  ServiceName,
  SystemInfoResult,
} from './index';

export const SERVICE_STATUSES = [
  'not_installed',
  'online',
  'starting',
  'degraded',
  'offline',
  'error',
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const BUSY_ACTIONS = [
  'installing',
  'starting',
  'stopping',
  'restarting',
  'updating',
  'removing',
] as const;
export type BusyAction = (typeof BUSY_ACTIONS)[number];

export interface ServiceSummary {
  name: ServiceName;
  displayName: string;
  description: string;
  lanPort: number;
  firstLoginTips: string[];
  status: ServiceStatus;
  // A plain-English reason shown when the status needs explaining.
  message: string | null;
  busy: BusyAction | null;
  errorCount: number;
  hints: string[];
}

export type SystemSummary = Pick<
  SystemInfoResult,
  | 'hostname'
  | 'cpuCount'
  | 'cpuLoadPercent'
  | 'memTotalBytes'
  | 'memFreeBytes'
  | 'diskTotalBytes'
  | 'diskFreeBytes'
  | 'temperatureCelsius'
  | 'uptimeSeconds'
>;

export interface StatusSnapshot {
  // False when the dashboard cannot reach the host agent, so every card is unreliable.
  agentReachable: boolean;
  services: ServiceSummary[];
  system: SystemSummary | null;
  updatedAt: string;
}

export type SessionInfo =
  | { state: 'setup_required' }
  | { state: 'logged_out'; setupAvailable: boolean }
  | { state: 'logged_in'; csrfToken: string; reauthRequired: boolean };

export interface ApiErrorBody {
  error: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface StorageJob {
  kind: 'formatting' | 'copying';
  target: string;
  state: 'running' | 'failed';
  message: string | null;
}

export interface StorageSnapshot {
  disks: DiskInfo[];
  missing: MissingDrive[];
  folders: FolderUsageResult[];
  job: StorageJob | null;
}
