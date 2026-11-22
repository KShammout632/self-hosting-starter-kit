import type { ServiceStatus } from '@selfhost/shared';
import { STATUS_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';

const DOT: Record<ServiceStatus, string> = {
  online: 'bg-success',
  starting: 'bg-warning animate-pulse',
  degraded: 'bg-warning',
  offline: 'bg-muted-foreground',
  error: 'bg-destructive',
  not_installed: 'border border-muted-foreground',
};

export function StatusBadge({ status, label }: { status: ServiceStatus; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium" data-status={status}>
      <span aria-hidden className={cn('size-2.5 rounded-full', DOT[status])} />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}
