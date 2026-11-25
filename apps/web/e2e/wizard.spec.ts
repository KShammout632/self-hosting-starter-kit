import { expect, test } from '@playwright/test';
import { jellyfin, mockApi, newState, newStorage, systemDisk } from './mock-api';

const fresh = () =>
  newState({
    session: {
      state: 'logged_in',
      csrfToken: 'csrf-test',
      reauthRequired: false,
      wizardComplete: false,
    },
    service: jellyfin({ status: 'not_installed', installed: false }),
    storage: newStorage([systemDisk()]),
  });

test.describe('setup wizard', () => {
  test('a new server walks through every step and lands on the home page', async ({ page }) => {
    const state = newState({
      session: { state: 'setup_required' },
      service: jellyfin({ status: 'not_installed', installed: false }),
      storage: newStorage([systemDisk()]),
    });
    await mockApi(page, state);
    await page.goto('/');

    await expect(page).toHaveURL(/\/wizard/);
    await page.getByLabel('Setup code').fill('ABCD-2345');
    await page.getByLabel('New password').fill('a long enough password');
    await page.getByLabel('Type the password again').fill('a long enough password');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(
      page.getByRole('heading', { name: 'Reach your server from anywhere' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();

    await expect(
      page.getByRole('heading', { name: 'Where should your files live?' }),
    ).toBeVisible();
    await expect(page.getByText('Only your server')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'Choose your apps' })).toBeVisible();
    await page.getByRole('checkbox', { name: /Jellyfin/ }).check();
    await page.getByRole('button', { name: 'Install the selected apps' }).click();
    await expect(page.getByText('Installed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'Your server is ready' })).toBeVisible();
    await expect(page.getByText('Open Jellyfin and create your admin account.')).toBeVisible();
    await page.getByRole('button', { name: 'Go to my dashboard' }).click();

    await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
    expect(state.requests.map((r) => r.path)).toEqual([
      '/api/setup',
      '/api/services/jellyfin/install',
      '/api/wizard/complete',
    ]);
    expect(state.requests[2]?.body).toEqual({ skipped: false });
  });

  test('every other page sends an unfinished server back to the guide, and a reload keeps the step', async ({
    page,
  }) => {
    await mockApi(page, fresh());
    await page.goto('/storage');
    await expect(page).toHaveURL(/\/wizard/);

    await page.goto('/wizard?step=drives');
    await expect(
      page.getByRole('heading', { name: 'Where should your files live?' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Where should your files live?' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(
      page.getByRole('heading', { name: 'Reach your server from anywhere' }),
    ).toBeVisible();
  });

  test('skip the rest ends the guide and it stays closed', async ({ page }) => {
    const state = fresh();
    await mockApi(page, state);
    await page.goto('/wizard?step=remote');
    await page.getByRole('button', { name: 'Skip the rest' }).click();

    await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
    expect(state.requests.at(-1)).toMatchObject({
      path: '/api/wizard/complete',
      body: { skipped: true },
    });
    await page.goto('/wizard');
    await expect(page).not.toHaveURL(/\/wizard/);
  });

  test('a server that was set up before the guide existed is never sent to it', async ({
    page,
  }) => {
    await mockApi(page, newState());
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/wizard/);
  });

  test('the guide can be run again from the home page without changing anything', async ({
    page,
  }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/');
    await page.getByRole('button', { name: 'Show details' }).first().click();
    await page.getByRole('link', { name: 'Run the setup guide again' }).click();

    await expect(
      page.getByRole('heading', { name: 'Reach your server from anywhere' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Go to my dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
    expect(state.requests).toEqual([]);
  });

  test('the apps step fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockApi(page, fresh());
    await page.goto('/wizard?step=services');
    await expect(page.getByRole('heading', { name: 'Choose your apps' })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  });
});
