import { expect, test } from '@playwright/test';
import { jellyfin, mockApi, newState } from './mock-api';

test.describe('setup and sign in', () => {
  test('first run: enter the setup code, choose a password, move on to the setup guide', async ({
    page,
  }) => {
    const state = newState({ session: { state: 'setup_required' } });
    await mockApi(page, state);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /set up your server/i })).toBeVisible();
    await page.getByLabel('Setup code').fill('ABCD-2345');
    await page.getByLabel('New password').fill('short');
    await page.getByLabel('Type the password again').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('at least 10 characters');

    await page.getByLabel('New password').fill('a long enough password');
    await page.getByLabel('Type the password again').fill('something else entirely');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');

    await page.getByLabel('Type the password again').fill('a long enough password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Reach your server from anywhere' }),
    ).toBeVisible();
    expect(state.requests[0]).toMatchObject({
      path: '/api/setup',
      body: { code: 'ABCD-2345', password: 'a long enough password' },
    });
  });

  test('sign in, wrong password, and sign out', async ({ page }) => {
    const state = newState({ session: { state: 'logged_out', setupAvailable: false } });
    await mockApi(page, state);
    await page.goto('/');

    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That password is not right.');

    await page.getByLabel('Password').fill('the right password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('forgot password explains the terminal command behind a toggle', async ({ page }) => {
    await mockApi(page, newState({ session: { state: 'logged_out', setupAvailable: false } }));
    await page.goto('/login');
    await expect(page.getByText('sudo selfhost reset-password')).toBeHidden();
    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    await expect(page.getByText('sudo selfhost reset-password')).toBeVisible();
  });
});

test.describe('home', () => {
  test('shows server health and the service card', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/');
    await expect(page.getByLabel('Server health')).toBeVisible();
    await expect(page.getByRole('meter', { name: 'Processor' })).toHaveAttribute(
      'aria-valuenow',
      '12',
    );
    await expect(page.getByLabel('Jellyfin')).toContainText('Online');
    await expect(page.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      'http://localhost:8096',
    );

    await expect(page.getByText('Processor cores')).toBeHidden();
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('Processor cores')).toBeVisible();
  });

  test('install, stop and start from the card', async ({ page }) => {
    const state = newState({ service: jellyfin({ status: 'not_installed' }) });
    await mockApi(page, state);
    await page.goto('/');

    const card = page.getByLabel('Jellyfin');
    await expect(card).toContainText('Not installed');
    await card.getByRole('button', { name: 'Install' }).click();
    await expect(card).toContainText('Online');

    await card.getByRole('button', { name: 'Stop' }).click();
    await expect(card).toContainText('Offline');
    await card.getByRole('button', { name: 'Start' }).click();
    await expect(card).toContainText('Online');

    expect(state.requests.map((r) => r.path)).toEqual([
      '/api/services/jellyfin/install',
      '/api/services/jellyfin/stop',
      '/api/services/jellyfin/start',
    ]);
  });

  test('shows progress while busy and a plain-English reason for errors', async ({ page }) => {
    const state = newState({ service: jellyfin({ status: 'not_installed', busy: 'installing' }) });
    await mockApi(page, state);
    await page.goto('/');
    await expect(page.getByRole('status')).toContainText('Installing');
    await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();

    state.service = jellyfin({ status: 'error', message: 'Docker is not running on the server.' });
    await page.reload();
    await expect(page.getByLabel('Jellyfin')).toContainText('Needs attention');
    await expect(page.getByLabel('Jellyfin')).toContainText('Docker is not running on the server.');
  });

  test('shows how many problems are in the log', async ({ page }) => {
    await mockApi(page, newState({ service: jellyfin({ errorCount: 3 }) }));
    await page.goto('/');
    await expect(page.getByText('3 problems were written to the log.')).toBeVisible();
  });

  test('warns when the helper on the server cannot be reached', async ({ page }) => {
    await mockApi(page, newState({ agentReachable: false }));
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('cannot reach the helper');
    await expect(page.getByText('systemctl status selfhost-agent')).toBeHidden();
    await page.getByRole('button', { name: 'Show details' }).first().click();
    await expect(page.getByText('systemctl status selfhost-agent')).toBeVisible();
  });

  test('stays inside the screen on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockApi(page, newState());
    await page.goto('/');
    await expect(page.getByLabel('Jellyfin')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('service page', () => {
  test('shows tips, suggestions and highlights error lines in the logs', async ({ page }) => {
    const state = newState({
      service: jellyfin({
        errorCount: 1,
        hints: ['The service is not allowed to read or write a folder.'],
      }),
    });
    await mockApi(page, state);
    await page.goto('/services/jellyfin');

    await expect(page.getByRole('heading', { name: 'Jellyfin', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Getting started')).toContainText('create your admin account');
    await expect(page.getByLabel('Suggestions')).toContainText('not allowed to read or write');

    const logs = page.getByLabel('Log lines');
    await expect(logs).toContainText('Server startup complete');
    await expect(logs.locator('[data-error]')).toHaveCount(1);
    await expect(logs.locator('[data-error]')).toContainText('Permission denied');

    await expect(logs).not.toContainText('2026-11-22T10:00:00Z');
    await page.getByLabel('Show details').check();
    await expect(logs).toContainText('2026-11-22T10:00:00Z');

    await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/services/jellyfin/logs/download',
    );
  });

  test('restart, update and stop send the matching requests', async ({ page }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/services/jellyfin');
    await page.getByRole('button', { name: 'Restart' }).click();
    await page.getByRole('button', { name: 'Update' }).click();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect
      .poll(() => state.requests.map((r) => r.path))
      .toEqual([
        '/api/services/jellyfin/restart',
        '/api/services/jellyfin/update',
        '/api/services/jellyfin/stop',
      ]);
  });

  test('removing keeps your data unless you tick the box and type the name', async ({ page }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/services/jellyfin');

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(
      page.getByText('Your own files, such as movies and photos, are never touched.'),
    ).toBeVisible();
    await page.getByLabel(/Also erase/).check();
    const confirmButton = page.getByRole('button', { name: 'Remove Jellyfin' });
    await expect(confirmButton).toBeDisabled();
    await page.getByLabel('Type jellyfin to confirm').fill('jellyfin');
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect
      .poll(() => state.requests.at(-1))
      .toMatchObject({
        path: '/api/services/jellyfin/uninstall',
        body: { deleteData: true, confirmName: 'jellyfin' },
      });
  });

  test('asks for the password again when the session is old, then repeats the action', async ({
    page,
  }) => {
    const state = newState({ reauthNeeded: true });
    await mockApi(page, state);
    await page.goto('/services/jellyfin');

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Remove Jellyfin' }).click();
    await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Password' }).fill('the right password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect
      .poll(() => state.requests.map((r) => r.path))
      .toEqual([
        '/api/services/jellyfin/uninstall',
        '/api/session/reauth',
        '/api/services/jellyfin/uninstall',
      ]);
  });

  test('shows the reason when an action is refused', async ({ page }) => {
    const state = newState();
    state.failNextAction = {
      status: 409,
      error: 'busy',
      message: 'Something else is already happening with this service.',
    };
    await mockApi(page, state);
    await page.goto('/services/jellyfin');
    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Something else is already happening with this service.',
    );
  });

  test('shows the admin login once and keeps it on screen until you leave', async ({ page }) => {
    const state = newState({
      service: jellyfin({
        name: 'nextcloud',
        displayName: 'Nextcloud',
        credentialsPending: true,
      }),
    });
    await mockApi(page, state);
    await page.goto('/services/nextcloud');

    const card = page.getByLabel('Your login details');
    await expect(card).toContainText('shown only once');
    await expect(page.getByText('correct-horse-battery')).toBeHidden();

    await card.getByRole('button', { name: 'Show my login' }).click();
    await expect(card.getByText('correct-horse-battery')).toBeVisible();
    await expect(card.getByText('admin', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Copy admin password' })).toBeVisible();
    await expect(card).toContainText('cannot be shown again after you leave this page');

    await page.reload();
    await expect(page.getByLabel('Your login details')).toBeHidden();
    await expect(page.getByText('correct-horse-battery')).toBeHidden();
  });

  test('does not offer login details for services that have none', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/services/jellyfin');
    await expect(page.getByRole('heading', { name: 'Jellyfin' })).toBeVisible();
    await expect(page.getByLabel('Your login details')).toBeHidden();
  });
});
