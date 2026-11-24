import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  LIBRARY_FOLDER_LABELS,
  type DiskInfo,
  type FolderUsageResult,
  type SmartResult,
  type StorageJob,
  type VolumeInfo,
} from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/status';
import { useStorage, useStorageAction } from '@/lib/use-storage';

const DEFAULT_SUBFOLDER: Record<string, string> = {
  movies: 'Movies',
  tv: 'TV',
  'home-videos': 'Home Videos',
  music: 'Music',
  photos: 'Photos',
  nextcloud: 'Nextcloud',
};

const FILESYSTEM_NAME: Record<string, string> = {
  ext4: 'Linux',
  ntfs: 'Windows',
  exfat: 'Windows',
};

const suggestName = (volume: VolumeInfo, index: number) => {
  const cleaned = (volume.fsLabel ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 16);
  return cleaned || `drive${index + 1}`;
};

const NAME_HINT = 'Use lowercase letters, numbers and dashes, starting with a letter.';
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

function SpaceMeter({ used, total }: { used: number; total: number }) {
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div>
      <div
        role="meter"
        aria-label="Space used"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={percent >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatBytes(total - used)} free of {formatBytes(total)}
        {percent >= 90 ? ' (almost full)' : ''}
      </p>
    </div>
  );
}

function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

function JobBanner({ job }: { job: StorageJob }) {
  const actions = useStorageAction();
  if (job.state === 'running') {
    return (
      <Card role="status" className="flex items-center gap-3">
        <Loader2 className="size-5 animate-spin" aria-hidden />
        <p className="text-sm">
          {job.kind === 'formatting'
            ? 'Preparing the new drive. This can take a few minutes. Please keep it plugged in.'
            : 'Moving your folder to the drive. Copying files can take a while.'}
        </p>
      </Card>
    );
  }
  return (
    <Card role="alert" className="space-y-2 border-destructive">
      <p className="text-sm font-medium">That did not finish.</p>
      <p className="text-sm">{job.message}</p>
      <Button size="sm" variant="outline" onClick={() => actions.run('/api/storage/job/dismiss')}>
        Dismiss
      </Button>
    </Card>
  );
}

function SetupDialog({
  volume,
  suggested,
  onClose,
}: {
  volume: VolumeInfo;
  suggested: string;
  onClose: () => void;
}) {
  const actions = useStorageAction(onClose);
  const [name, setName] = useState(suggested);
  const valid = NAME_PATTERN.test(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await actions.run(`/api/disks/${volume.uuid}/mount`, { label: name });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Set up this drive"
      description="Your files on it are not changed."
    >
      <>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="drive-name">
            Name for this drive
          </label>
          <Input
            id="drive-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={16}
          />
          <p className="text-xs text-muted-foreground">{NAME_HINT}</p>
          {volume.filesystem && !volume.keepsPermissions ? (
            <p className="text-sm">
              This drive was made for Windows. It will work, but it cannot keep file permissions the
              way a Linux drive does.
            </p>
          ) : null}
          <ErrorText message={actions.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || actions.busy}>
              Set up drive
            </Button>
          </div>
        </form>
        {actions.dialog}
      </>
    </Dialog>
  );
}

function UnmountDialog({
  volume,
  onClose,
  onDone,
}: {
  volume: VolumeInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const actions = useStorageAction(() => {
    onDone();
    onClose();
  });
  const submit = () => actions.run(`/api/disks/${volume.uuid}/unmount`, { stopServices: true });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Unmount this drive"
      description="Any app that uses it will be stopped first, so nothing is lost. You can start them again from the Home page."
    >
      <div className="space-y-3">
        <ErrorText message={actions.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={actions.busy} onClick={submit}>
            Stop apps and unmount
          </Button>
        </div>
        {actions.dialog}
      </div>
    </Dialog>
  );
}

function FormatDialog({ disk, onClose }: { disk: DiskInfo; onClose: () => void }) {
  const actions = useStorageAction(onClose);
  const [name, setName] = useState('media1');
  const [typed, setTyped] = useState('');
  const valid = NAME_PATTERN.test(name) && typed === disk.device;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await actions.run(`/api/disks/by-device/${disk.device}/format`, {
      diskId: disk.diskId,
      label: name,
      confirmName: typed,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Erase and prepare this drive"
      description={`Everything on ${disk.model ?? 'this drive'} (${formatBytes(disk.sizeBytes)}${disk.serial ? `, serial number ${disk.serial}` : ''}) will be erased and cannot be recovered.`}
    >
      <>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="new-drive-name">
            Name for the new drive
          </label>
          <Input
            id="new-drive-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={16}
          />
          <p className="text-xs text-muted-foreground">{NAME_HINT}</p>
          <label className="block text-sm font-medium" htmlFor="erase-confirm">
            To confirm, type the drive code <strong>{disk.device}</strong>
          </label>
          <Input
            id="erase-confirm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
          <ErrorText message={actions.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid || actions.busy}>
              Erase and prepare
            </Button>
          </div>
        </form>
        {actions.dialog}
      </>
    </Dialog>
  );
}

function HealthCheck({ uuid }: { uuid: string }) {
  const [result, setResult] = useState<SmartResult | 'unavailable' | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      setResult(await api<SmartResult>(`/api/disks/${uuid}/smart`));
    } catch {
      setResult('unavailable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={check}>
        Check health
      </Button>
      {result === 'unavailable' ? <p className="text-sm">The health check could not run.</p> : null}
      {result && result !== 'unavailable' ? (
        <div role="status" className="space-y-1 text-sm">
          {!result.supported ? (
            <p>This drive does not share health information.</p>
          ) : (
            <p className="font-medium">
              {result.warnings.length === 0 ? 'Healthy' : 'Needs attention'}
              {result.temperatureCelsius !== null ? `, ${result.temperatureCelsius} °C` : ''}
            </p>
          )}
          {result.warnings.map((warning) => (
            <p key={warning} className="text-warning">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type Dialogs =
  | { kind: 'setup'; volume: VolumeInfo; suggested: string }
  | { kind: 'unmount'; volume: VolumeInfo }
  | { kind: 'format'; disk: DiskInfo };

function volumeState(volume: VolumeInfo) {
  if (volume.mounted && volume.mountLabel) return 'ready';
  if (volume.configured) return 'unplugged';
  return 'new';
}

function DiskCard({
  disk,
  busy,
  unplugged,
  open,
  index,
}: {
  disk: DiskInfo;
  busy: boolean;
  unplugged: Set<string>;
  open: (dialog: Dialogs) => void;
  index: number;
}) {
  const [details, setDetails] = useState(false);
  const title = disk.model ?? 'Drive';
  return (
    <Card className="space-y-4" aria-label={`${title} ${formatBytes(disk.sizeBytes)}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {formatBytes(disk.sizeBytes)}
            {disk.transport === 'usb' ? ', plugged in by USB' : ''}
          </p>
        </div>
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => setDetails((value) => !value)}
        >
          {details ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {disk.isSystem ? (
        <p className="text-sm">
          Your server runs from this drive, so it is kept safe and cannot be changed here.
        </p>
      ) : null}

      {details ? (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Drive code</dt>
            <dd>{disk.device}</dd>
          </div>
          {disk.serial ? (
            <div>
              <dt className="text-muted-foreground">Serial number</dt>
              <dd className="break-all">{disk.serial}</dd>
            </div>
          ) : null}
          {disk.volumes.map((volume) => (
            <div key={volume.uuid}>
              <dt className="text-muted-foreground">{volume.partition}</dt>
              <dd className="break-all">
                {volume.filesystem ?? 'unknown'}, {volume.uuid}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {!disk.isSystem
        ? disk.volumes.map((volume) => {
            const state = volumeState(volume);
            const name = volume.mountLabel ?? volume.fsLabel ?? 'Unnamed drive';
            const total = volume.usedBytes !== null && volume.freeBytes !== null;
            return (
              <div key={volume.uuid} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{name}</p>
                  <span className="text-sm text-muted-foreground">
                    {state === 'ready'
                      ? 'Ready to use'
                      : state === 'unplugged'
                        ? 'Not connected'
                        : 'Not set up yet'}
                    {volume.filesystem && FILESYSTEM_NAME[volume.filesystem]
                      ? `, ${FILESYSTEM_NAME[volume.filesystem]} format`
                      : ''}
                  </span>
                </div>
                {state === 'ready' && total ? (
                  <SpaceMeter
                    used={volume.usedBytes as number}
                    total={(volume.usedBytes as number) + (volume.freeBytes as number)}
                  />
                ) : null}
                {state === 'unplugged' && !unplugged.has(volume.uuid) ? (
                  <p className="text-sm">
                    This drive is not connected. Plug it back in, then mount it again.
                  </p>
                ) : null}
                {unplugged.has(volume.uuid) && state !== 'ready' ? (
                  <p role="status" className="text-sm font-medium text-success">
                    Safe to unplug.
                  </p>
                ) : null}
                {!volume.mountable && state === 'new' ? (
                  <p className="text-sm text-muted-foreground">
                    This drive format is not supported. Linux, NTFS and exFAT drives work.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {state !== 'ready' && volume.mountable ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        open({
                          kind: 'setup',
                          volume,
                          suggested: volume.mountLabel ?? suggestName(volume, index),
                        })
                      }
                    >
                      {state === 'unplugged' ? 'Mount again' : 'Set up this drive'}
                    </Button>
                  ) : null}
                  {state === 'ready' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => open({ kind: 'unmount', volume })}
                    >
                      Unmount
                    </Button>
                  ) : null}
                  {state === 'ready' ? <HealthCheck uuid={volume.uuid} /> : null}
                </div>
              </div>
            );
          })
        : null}

      {!disk.isSystem && disk.canFormat ? (
        <div className="border-t pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => open({ kind: 'format', disk })}
          >
            Erase and prepare as a new drive
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function FolderDialog({
  folder,
  disks,
  onClose,
}: {
  folder: FolderUsageResult;
  disks: DiskInfo[];
  onClose: () => void;
}) {
  const actions = useStorageAction(onClose);
  const ready = disks.flatMap((disk) => disk.volumes).filter((v) => v.mounted && v.mountLabel);
  const [uuid, setUuid] = useState(ready[0]?.uuid ?? '');
  const [subpath, setSubpath] = useState(DEFAULT_SUBFOLDER[folder.folder] ?? '');
  const [copy, setCopy] = useState(folder.hasLocalFiles);
  const label = LIBRARY_FOLDER_LABELS[folder.folder];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await actions.run(`/api/folders/${folder.folder}/assign`, {
      uuid,
      subpath,
      copyExisting: copy,
      stopServices: true,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Where should ${label} live?`}
      description="Apps that use this folder are stopped for a moment and started again."
    >
      {ready.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm">Set up a drive first, then come back to choose its folders.</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="folder-drive">
              Drive
            </label>
            <select
              id="folder-drive"
              className="h-10 w-full rounded-md border bg-card px-3 text-sm"
              value={uuid}
              onChange={(event) => setUuid(event.target.value)}
            >
              {ready.map((volume) => (
                <option key={volume.uuid} value={volume.uuid}>
                  {volume.mountLabel}
                </option>
              ))}
            </select>
            <label className="block text-sm font-medium" htmlFor="folder-name">
              Folder on that drive
            </label>
            <Input
              id="folder-name"
              value={subpath}
              onChange={(event) => setSubpath(event.target.value)}
              maxLength={64}
            />
            {folder.hasLocalFiles ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={copy}
                  onChange={(event) => setCopy(event.target.checked)}
                />
                Copy the files already in {label} to the drive. Without this they are hidden.
              </label>
            ) : null}
            <ErrorText message={actions.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={actions.busy || subpath.trim() === ''}>
                Use this drive
              </Button>
            </div>
          </form>
          {actions.dialog}
        </>
      )}
    </Dialog>
  );
}

function FolderRow({
  folder,
  busy,
  onChange,
}: {
  folder: FolderUsageResult;
  busy: boolean;
  onChange: () => void;
}) {
  const where = folder.mapped
    ? `${folder.mapped.mountLabel} / ${folder.mapped.subpath}`
    : 'On your server’s main drive';
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div>
        <p className="font-medium">{LIBRARY_FOLDER_LABELS[folder.folder]}</p>
        <p className="text-sm text-muted-foreground">{where}</p>
        {folder.volumeMissing ? (
          <p role="alert" className="text-sm text-destructive">
            This drive is not connected. Plug it back in and mount it.
          </p>
        ) : null}
        {folder.nearlyFull ? (
          <p className="text-sm text-warning">This drive is almost full.</p>
        ) : null}
        {folder.freeBytes !== null ? (
          <p className="text-xs text-muted-foreground">{formatBytes(folder.freeBytes)} free</p>
        ) : null}
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={onChange}>
        Change
      </Button>
    </li>
  );
}

export function StorageManager() {
  const storage = useStorage();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderUsageResult | null>(null);
  const [unplugged, setUnplugged] = useState<Set<string>>(new Set());

  if (storage.isPending) return <p className="text-muted-foreground">Loading...</p>;
  if (storage.isError) {
    const message =
      storage.error instanceof ApiError
        ? storage.error.message
        : 'Could not load your drives. Try reloading the page.';
    return <p role="alert">{message}</p>;
  }

  const { disks, missing, folders, job } = storage.data;
  const busy = job?.state === 'running';
  const close = () => setDialog(null);

  return (
    <div className="space-y-6">
      {job ? <JobBanner job={job} /> : null}

      <section className="space-y-3" aria-label="Drives">
        <h2 className="font-semibold">Drives</h2>
        {missing.map((drive) => (
          <Card key={drive.uuid} role="alert" aria-label={`${drive.mountLabel} is not connected`}>
            <p className="font-medium">{drive.mountLabel} is not connected</p>
            <p className="text-sm">
              Plug it back in. It will be found again after a moment, and you can mount it from
              here.
            </p>
          </Card>
        ))}
        {disks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No drives were found.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {disks.map((disk, index) => (
              <DiskCard
                key={disk.device}
                disk={disk}
                index={index}
                busy={busy}
                unplugged={unplugged}
                open={setDialog}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Library folders">
        <Card>
          <h2 className="font-semibold">Where your libraries are kept</h2>
          <ul className="divide-y">
            {folders.map((folder) => (
              <FolderRow
                key={folder.folder}
                folder={folder}
                busy={busy}
                onChange={() => setFolderDialog(folder)}
              />
            ))}
          </ul>
        </Card>
      </section>

      {dialog?.kind === 'setup' ? (
        <SetupDialog volume={dialog.volume} suggested={dialog.suggested} onClose={close} />
      ) : null}
      {dialog?.kind === 'unmount' ? (
        <UnmountDialog
          volume={dialog.volume}
          onClose={close}
          onDone={() => setUnplugged((set) => new Set(set).add(dialog.volume.uuid))}
        />
      ) : null}
      {dialog?.kind === 'format' ? <FormatDialog disk={dialog.disk} onClose={close} /> : null}
      {folderDialog ? (
        <FolderDialog folder={folderDialog} disks={disks} onClose={() => setFolderDialog(null)} />
      ) : null}
    </div>
  );
}
