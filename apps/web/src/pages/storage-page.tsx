import { StorageManager } from '@/components/storage-manager';

export function StoragePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Storage</h1>
        <p className="text-sm text-muted-foreground">
          Drives plugged into your server, and where each of your libraries is kept.
        </p>
      </div>
      <StorageManager />
    </div>
  );
}
