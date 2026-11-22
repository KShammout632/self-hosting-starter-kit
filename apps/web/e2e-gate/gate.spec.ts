import { expect, test } from '@playwright/test';

// M2 exit gate: start, stop and read logs from the browser only. Everything below is done by
// clicking in the real dashboard on a freshly installed server. The only thing not done in the
// browser is running the installer, which is how a real user gets the setup code.
const SETUP_CODE = process.env.SETUP_CODE ?? '';
const PASSWORD = 'gate password 12345';

test('set up, install Jellyfin, stop it, start it, read its logs, remove it', async ({ page }) => {
  expect(SETUP_CODE, 'SETUP_CODE must be set').not.toBe('');
  const card = page.getByLabel('Jellyfin');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up your server' })).toBeVisible();

  await page.getByLabel('Setup code').fill('WRONG-CODE');
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByLabel('Type the password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('setup code is not right');

  await page.getByLabel('Setup code').fill(SETUP_CODE);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
  await expect(page.getByLabel('Server health')).toBeVisible();
  await expect(card).toContainText('Not installed');

  await card.getByRole('button', { name: 'Install' }).click();
  await expect(card.getByRole('status')).toContainText('Installing');
  await expect(card).toContainText('Online', { timeout: 10 * 60_000 });

  await card.getByRole('link', { name: 'Details and logs' }).click();
  await expect(page.getByRole('heading', { name: 'Jellyfin', level: 1 })).toBeVisible();
  const logs = page.getByLabel('Log lines');
  await expect(logs).not.toContainText('No log lines yet.', { timeout: 60_000 });
  await expect(logs).toContainText(/\S/);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('main')).toContainText('Offline', { timeout: 3 * 60_000 });

  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('main')).toContainText('Online', { timeout: 5 * 60_000 });

  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.locator('main')).toContainText('Online', { timeout: 5 * 60_000 });

  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Jellyfin' }).click();
  await expect(page.locator('main')).toContainText('Not installed', { timeout: 3 * 60_000 });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
});
