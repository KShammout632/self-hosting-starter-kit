import { expect, test } from '@playwright/test';
import { mockApi, newKit, newState, newSystemUpdates } from './mock-api';

test.describe('settings page', () => {
  test('is reachable from the menu', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('You are up to date.')).toBeVisible();
    await expect(page.getByText('Everything is up to date.')).toBeVisible();
  });

  test('changes the password after checking the two new ones match', async ({ page }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/settings');

    await page.getByLabel('Current password').fill('the right password');
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByLabel('Type the new password again').fill('short');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText('at least 10 characters');

    await page.getByLabel('New password', { exact: true }).fill('a long enough password');
    await page.getByLabel('Type the new password again').fill('something else entirely');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');

    await page.getByLabel('Type the new password again').fill('a long enough password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status')).toContainText('Your password was changed');
    expect(state.requests.find((r) => r.path === '/api/settings/password')?.body).toEqual({
      current: 'the right password',
      next: 'a long enough password',
    });
  });

  test('says when the current password is wrong', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/settings');
    await page.getByLabel('Current password').fill('wrong password');
    await page.getByLabel('New password', { exact: true }).fill('a long enough password');
    await page.getByLabel('Type the new password again').fill('a long enough password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toHaveText('Your current password is not right.');
  });

  test('offers a kit update and starts it', async ({ page }) => {
    const state = newState({
      kit: newKit({ latestVersion: '0.2.0', updateAvailable: true }),
    });
    await mockApi(page, state);
    await page.goto('/settings');

    await expect(page.getByText('Version 0.2.0 is available.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'What is new' })).toBeVisible();
    await page.getByRole('button', { name: 'Update now' }).click();
    await expect(page.getByText('Updating to version 0.2.0')).toBeVisible();
    expect(state.requests.some((r) => r.path === '/api/settings/kit/update')).toBe(true);
  });

  test('asks for the password again when it has been a while', async ({ page }) => {
    const state = newState({
      kit: newKit({ latestVersion: '0.2.0', updateAvailable: true }),
      reauthNeeded: true,
    });
    await mockApi(page, state);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Update now' }).click();
    await expect(page.getByRole('dialog')).toContainText('Enter your password');
    await page.getByRole('dialog').getByLabel('Password').fill('the right password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Updating to version 0.2.0')).toBeVisible();
  });

  test('explains a rolled back update', async ({ page }) => {
    await mockApi(
      page,
      newState({
        kit: newKit({
          update: {
            state: 'rolled_back',
            version: '0.2.0',
            message: 'The new version did not start, so the old one was put back.',
            at: new Date().toISOString(),
          },
        }),
      }),
    );
    await page.goto('/settings');
    await expect(page.getByRole('alert')).toContainText('the old one was put back');
  });

  test('installs server updates and shows a restart notice on every page', async ({ page }) => {
    const state = newState({
      systemUpdates: newSystemUpdates({ packages: 4, security: 2, rebootRequired: true }),
    });
    await mockApi(page, state);
    await page.goto('/');
    await expect(page.getByText('The server needs a restart')).toBeVisible();

    await page.getByRole('link', { name: 'Open settings' }).click();
    await expect(
      page.getByText('4 updates are waiting, including 2 security fixes.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Install updates' }).click();
    await expect
      .poll(() => state.requests.some((r) => r.path === '/api/settings/system/apply'))
      .toBe(true);
  });

  test('restarting needs a second click', async ({ page }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/settings');

    await page.getByRole('button', { name: 'Restart the server' }).click();
    await expect(page.getByRole('dialog')).toContainText('disconnected');
    expect(state.requests.some((r) => r.path === '/api/settings/reboot')).toBe(false);
    await page.getByRole('button', { name: 'Restart now' }).click();
    await expect(page.getByText('The server is restarting.')).toBeVisible();
    expect(state.requests.some((r) => r.path === '/api/settings/reboot')).toBe(true);
  });

  test('shows recent activity, with the technical details on request', async ({ page }) => {
    await mockApi(
      page,
      newState({
        audit: [
          {
            ts: Date.now(),
            actor: 'admin',
            event: 'service.install',
            target: 'jellyfin',
            outcome: 'ok',
            detail: null,
          },
          {
            ts: Date.now() - 60_000,
            actor: 'anonymous',
            event: 'login',
            target: null,
            outcome: 'denied',
            detail: null,
          },
        ],
      }),
    );
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Show activity' }).click();

    const list = page.getByRole('list', { name: 'Activity' });
    await expect(list).toContainText('App installed: jellyfin');
    await expect(list).toContainText('Signed in (refused)');
    await expect(list.locator('code')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(list.locator('code').first()).toContainText('admin | service.install | jellyfin');
  });
});
