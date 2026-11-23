import { expect, test } from '@playwright/test';

// M2 exit gate (start, stop and read logs from the browser only) and the M4c setup wizard. Everything
// below is done by clicking in the real dashboard on a freshly installed server. The only thing not done in the
// browser is running the installer, which is how a real user gets the setup code.
const SETUP_CODE = process.env.SETUP_CODE ?? '';
const PASSWORD = 'gate password 12345';

test('walk the setup wizard, install Jellyfin, stop it, start it, read its logs, remove it', async ({
  page,
}) => {
  expect(SETUP_CODE, 'SETUP_CODE must be set').not.toBe('');
  const card = page.getByLabel('Jellyfin');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /set up your server/i })).toBeVisible();

  await page.getByLabel('Setup code').fill('WRONG-CODE');
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByLabel('Type the password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('setup code is not right');

  await page.getByLabel('Setup code').fill(SETUP_CODE);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(
    page.getByRole('heading', { name: 'Reach your server from anywhere' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.getByRole('heading', { name: 'Where should your files live?' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Choose your apps' })).toBeVisible();
  await page.getByRole('checkbox', { name: /Jellyfin/ }).check();
  await page.getByRole('button', { name: 'Install the selected apps' }).click();
  await expect(page.locator('[aria-label="Jellyfin"]').getByRole('status')).toContainText(
    'Installing',
  );
  await expect(page.locator('[aria-label="Jellyfin"]')).toContainText('Installed', {
    timeout: 10 * 60_000,
  });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Your server is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to my dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
  await expect(page.getByLabel('Server health')).toBeVisible();
  await expect(card).toContainText('Online', { timeout: 10 * 60_000 });

  await page.reload();
  await expect(page).not.toHaveURL(/wizard/);
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
