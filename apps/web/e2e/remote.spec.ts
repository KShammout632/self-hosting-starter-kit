import { expect, test } from '@playwright/test';
import { mockApi, newRemote, newState, readyRemote } from './mock-api';

test.describe('remote access page', () => {
  test('is reachable from the menu and offers the machine name', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/');
    await page.getByRole('link', { name: 'Remote access' }).click();

    await expect(page.getByRole('heading', { name: 'Remote access' })).toBeVisible();
    await expect(page.getByLabel('Name for this server')).toHaveValue('homeserver');
  });

  test('walks through sign in and the two Tailscale settings', async ({ page }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/remote');

    const name = page.getByLabel('Name for this server');
    await name.fill('Bad Name!');
    await expect(page.getByRole('button', { name: 'Connect to Tailscale' })).toBeDisabled();
    await name.fill('my-server');
    await page.getByRole('button', { name: 'Connect to Tailscale' }).click();

    await expect(page.getByRole('heading', { name: 'Step 1: Sign in to Tailscale' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open the Tailscale sign-in page' }),
    ).toHaveAttribute('href', 'https://login.tailscale.com/a/abc123');
    await expect(page.getByLabel('QR code for the sign-in page')).toBeVisible();
    expect(state.requests.find((r) => r.path === '/api/remote/connect')?.body).toEqual({
      name: 'my-server',
    });

    state.remote = newRemote({ state: 'needs_settings', magicDnsEnabled: true });
    await expect(
      page.getByRole('heading', { name: 'Step 2: Turn on two Tailscale settings' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel('Off')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Open the Tailscale admin page' })).toHaveAttribute(
      'href',
      'https://login.tailscale.com/admin/dns',
    );

    state.remote = readyRemote();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByRole('heading', { name: 'Remote access is on' })).toBeVisible();
  });

  test('lists the addresses with a QR code on request', async ({ page }) => {
    await mockApi(page, newState({ remote: readyRemote() }));
    await page.goto('/remote');

    const row = page.getByRole('listitem', { name: 'Jellyfin' });
    await expect(row).toContainText('https://homeserver.tail1234.ts.net:8920');
    await expect(row.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      'https://homeserver.tail1234.ts.net:8920',
    );
    await expect(row.getByLabel('QR code for Jellyfin')).toBeHidden();
    await row.getByRole('button', { name: 'QR code' }).click();
    await expect(row.getByLabel('QR code for Jellyfin')).toBeVisible();
  });

  test('hides technical detail until asked', async ({ page }) => {
    await mockApi(page, newState({ remote: readyRemote() }));
    await page.goto('/remote');
    await expect(page.getByText('Disable key expiry')).toBeHidden();
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('Disable key expiry')).toBeVisible();
  });

  test('turning remote access off asks for confirmation and the password when it is old', async ({
    page,
  }) => {
    const state = newState({ remote: readyRemote(), reauthNeeded: true });
    await mockApi(page, state);
    await page.goto('/remote');

    await page.getByRole('button', { name: 'Show details' }).click();
    await page.getByRole('button', { name: 'Turn off remote access' }).click();
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.getByRole('textbox', { name: 'Password' }).fill('a long enough password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByLabel('Name for this server')).toBeVisible();
    expect(state.requests.filter((r) => r.path === '/api/remote/disconnect')).toHaveLength(2);
  });

  test('says when Tailscale is not installed', async ({ page }) => {
    await mockApi(page, newState({ remote: newRemote({ state: 'not_installed' }) }));
    await page.goto('/remote');
    await expect(page.getByRole('alert')).toContainText('Tailscale is not installed');
  });

  test('home page links to the address that works away from home', async ({ page }) => {
    await mockApi(page, newState({ remote: readyRemote() }));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Open from anywhere' })).toHaveAttribute(
      'href',
      'https://homeserver.tail1234.ts.net:8920',
    );
  });
});
