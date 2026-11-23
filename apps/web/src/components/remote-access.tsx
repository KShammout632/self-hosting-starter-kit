import { Check, Circle, Copy, Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState, type FormEvent } from 'react';
import type { RemoteLink, RemoteSnapshot } from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useRemote, useRemoteAction } from '@/lib/use-remote';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

function ConnectCard({ remote }: { remote: RemoteSnapshot }) {
  const actions = useRemoteAction();
  const [name, setName] = useState(remote.name);
  const valid = NAME_PATTERN.test(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await actions.run('/api/remote/connect', { name });
  };

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Use your apps away from home</h2>
      <p className="text-sm">
        Tailscale is a free service that gives your phone a private, secure way to reach this server
        from anywhere. Nothing is opened up to the internet. You need a free Tailscale account,
        which you can create in the next step.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="remote-name">
          Name for this server
        </label>
        <Input
          id="remote-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={63}
        />
        <p className="text-xs text-muted-foreground">
          Use lowercase letters, numbers and dashes. This becomes part of your addresses.
        </p>
        <ErrorText message={actions.error} />
        <Button type="submit" disabled={!valid || actions.busy}>
          {actions.busy ? 'Connecting...' : 'Connect to Tailscale'}
        </Button>
      </form>
      {actions.dialog}
    </Card>
  );
}

function SignInCard({ url }: { url: string }) {
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Step 1: Sign in to Tailscale</h2>
      <p className="text-sm">
        Open the sign-in page and log in or create a free account. You can also scan the code with
        your phone.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button asChild>
          <a href={url} target="_blank" rel="noreferrer">
            Open the Tailscale sign-in page
          </a>
        </Button>
        <div className="rounded-md bg-white p-2" aria-label="QR code for the sign-in page">
          <QRCodeSVG value={url} size={112} />
        </div>
      </div>
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Waiting for you to finish signing in...
      </p>
    </Card>
  );
}

function SettingRow({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {done ? (
        <Check className="size-4 text-success" aria-label="On" />
      ) : (
        <Circle className="size-4 text-muted-foreground" aria-label="Off" />
      )}
      {label}
    </li>
  );
}

function SettingsCard({ remote }: { remote: RemoteSnapshot }) {
  const actions = useRemoteAction();
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Step 2: Turn on two Tailscale settings</h2>
      <p className="text-sm">
        Your server is signed in. To give your apps secure addresses, switch on both settings below
        in the Tailscale admin page. They are on the DNS page, and each is a single button.
      </p>
      <ul className="space-y-1">
        <SettingRow done={remote.magicDnsEnabled} label="MagicDNS" />
        <SettingRow done={remote.httpsEnabled} label="HTTPS certificates" />
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href={remote.settingsUrl} target="_blank" rel="noreferrer">
            Open the Tailscale admin page
          </a>
        </Button>
        <Button variant="outline" onClick={() => actions.recheck()}>
          Check again
        </Button>
      </div>
    </Card>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy the ${label} address`}>
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function LinkRow({ link }: { link: RemoteLink }) {
  const [showCode, setShowCode] = useState(false);
  return (
    <li aria-label={link.label} className="space-y-2 border-t py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{link.label}</p>
          <p className="text-xs break-all text-muted-foreground">{link.url}</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" asChild>
            <a href={link.url} target="_blank" rel="noreferrer">
              Open
            </a>
          </Button>
          <CopyButton text={link.url} label={link.label} />
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showCode}
            onClick={() => setShowCode((value) => !value)}
          >
            {showCode ? 'Hide QR code' : 'QR code'}
          </Button>
        </div>
      </div>
      {showCode ? (
        <div
          className="inline-block rounded-md bg-white p-2"
          aria-label={`QR code for ${link.label}`}
        >
          <QRCodeSVG value={link.url} size={128} />
        </div>
      ) : null}
    </li>
  );
}

function DisconnectDialog({ onClose }: { onClose: () => void }) {
  const actions = useRemoteAction();
  const submit = async () => {
    if (await actions.run('/api/remote/disconnect')) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Turn off remote access"
      description="Your apps will stop working away from home until you connect again. Nothing on this server is deleted."
    >
      <div className="space-y-3">
        <ErrorText message={actions.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={actions.busy} onClick={submit}>
            Turn off
          </Button>
        </div>
        {actions.dialog}
      </div>
    </Dialog>
  );
}

function ReadyCard({ remote }: { remote: RemoteSnapshot }) {
  const [details, setDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Remote access is on</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={details}
          onClick={() => setDetails((value) => !value)}
        >
          {details ? 'Hide details' : 'Show details'}
        </Button>
      </div>
      <p className="text-sm">
        Install the Tailscale app on your phone and sign in with the same account. Then use these
        addresses in your apps, at home or away.
      </p>
      {remote.message ? (
        <p role="alert" className="text-sm text-warning">
          {remote.message}
        </p>
      ) : null}
      <ul>
        {remote.links.map((link) => (
          <LinkRow key={link.target} link={link} />
        ))}
      </ul>
      {details ? (
        <div className="space-y-2 text-sm">
          <p>
            Server name on Tailscale: <code className="rounded bg-muted px-1">{remote.name}</code>
          </p>
          <p>
            To stop this server from signing itself out after about six months, open it in the
            Tailscale admin page and choose "Disable key expiry".
          </p>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Turn off remote access
          </Button>
        </div>
      ) : null}
      {confirming ? <DisconnectDialog onClose={() => setConfirming(false)} /> : null}
    </Card>
  );
}

export function RemoteAccess() {
  const remote = useRemote();
  if (remote.isPending) return <p className="text-muted-foreground">Loading...</p>;
  if (remote.isError) {
    return (
      <p role="alert" className="text-destructive">
        Could not check remote access. Try reloading the page.
      </p>
    );
  }
  const { data } = remote;
  switch (data.state) {
    case 'not_installed':
      return (
        <Card role="alert" className="space-y-2">
          <h2 className="text-lg font-semibold">Tailscale is not installed</h2>
          <p className="text-sm">Run the installer on the server again to add it.</p>
        </Card>
      );
    case 'signed_out':
      return <ConnectCard remote={data} />;
    case 'waiting_for_sign_in':
      return data.signInUrl ? <SignInCard url={data.signInUrl} /> : <ConnectCard remote={data} />;
    case 'needs_settings':
      return <SettingsCard remote={data} />;
    case 'ready':
      return <ReadyCard remote={data} />;
  }
}
