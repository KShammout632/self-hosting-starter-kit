import { useState } from 'react';
import type { ServiceCredentialsResult } from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';

type Credentials = ServiceCredentialsResult['credentials'];

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={'Copy ' + label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// The server hands these over once. The values live only in this page's memory, so a reload
// loses them, and the card says so before the owner asks to see them.
export function CredentialsCard({
  service,
  displayName,
  revealed,
  onReveal,
}: {
  service: string;
  displayName: string;
  revealed: Credentials | null;
  onReveal: (credentials: Credentials) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ServiceCredentialsResult>(`/api/services/${service}/credentials`, {
        method: 'POST',
      });
      onReveal(result.credentials);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3" aria-label="Your login details">
      <h2 className="font-semibold">Your {displayName} login</h2>
      {revealed ? (
        <>
          <p className="text-sm">
            Write these down or copy them now. They are shown only once and cannot be shown again
            after you leave this page.
          </p>
          <dl className="space-y-2 text-sm">
            {revealed.map((entry) => (
              <div key={entry.label} className="flex flex-wrap items-center gap-2">
                <dt className="w-40 text-muted-foreground">{entry.label}</dt>
                <dd className="break-all font-mono">{entry.value}</dd>
                <CopyButton value={entry.value} label={entry.label.toLowerCase()} />
              </div>
            ))}
          </dl>
        </>
      ) : (
        <>
          <p className="text-sm">
            {displayName} made an admin login for you. It can be shown only once, so be ready to
            write it down or copy it before you press the button.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button onClick={() => void reveal()} disabled={busy}>
            {busy ? 'Getting it...' : 'Show my login'}
          </Button>
        </>
      )}
    </Card>
  );
}
