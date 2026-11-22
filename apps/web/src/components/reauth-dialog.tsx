import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';

export function ReauthDialog({
  open,
  onDone,
  onCancel,
}: {
  open: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/session/reauth', { method: 'POST', body: { password } });
      setPassword('');
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Enter your password"
      description="This keeps the server safe. You only need to do this now and then."
    >
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="reauth-password">
          Password
        </label>
        <Input
          id="reauth-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || password === ''}>
            Continue
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
