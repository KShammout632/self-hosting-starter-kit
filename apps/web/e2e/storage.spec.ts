import { expect, test } from '@playwright/test';
import { mockApi, newState, newStorage, systemDisk, usbDisk, volume } from './mock-api';

test.describe('storage page', () => {
  test('is reachable from the menu and lists the drives', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/');
    await page.getByRole('link', { name: 'Storage' }).click();

    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
    await expect(page.getByLabel(/Internal SSD/)).toContainText('cannot be changed here');
    await expect(page.getByLabel(/Portable USB Drive/)).toContainText('Not set up yet');
  });

  test('hides technical detail until asked', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/storage');
    const card = page.getByLabel(/Portable USB Drive/);
    await expect(card.getByText('Drive code')).toBeHidden();
    await card.getByRole('button', { name: 'Show details' }).click();
    await expect(card.getByText('Drive code')).toBeVisible();
    await expect(card.getByText('sdb', { exact: true })).toBeVisible();
  });

  test('sets up a drive with a name and then shows it ready with free space', async ({ page }) => {
    const state = newState();
    await mockApi(page, state);
    await page.goto('/storage');

    await page.getByRole('button', { name: 'Set up this drive' }).click();
    const name = page.getByLabel('Name for this drive');
    await expect(name).toHaveValue('media');
    await name.fill('Bad Name');
    await expect(page.getByRole('button', { name: 'Set up drive' })).toBeDisabled();
    await name.fill('media1');
    await page.getByRole('button', { name: 'Set up drive' }).click();

    await expect(page.getByLabel(/Portable USB Drive/)).toContainText('Ready to use');
    await expect(page.getByRole('meter', { name: 'Space used' })).toBeVisible();
    expect(state.requests.find((r) => r.path.endsWith('/mount'))?.body).toEqual({
      label: 'media1',
    });
  });

  test('warns about Windows drives', async ({ page }) => {
    const state = newState({
      storage: newStorage([
        systemDisk(),
        usbDisk([volume({ filesystem: 'ntfs', keepsPermissions: false })]),
      ]),
    });
    await mockApi(page, state);
    await page.goto('/storage');
    await page.getByRole('button', { name: 'Set up this drive' }).click();
    await expect(page.getByRole('dialog')).toContainText('made for Windows');
  });

  test('warns when a drive is almost full', async ({ page }) => {
    const state = newState({
      storage: newStorage([
        systemDisk(),
        usbDisk([
          volume({
            mounted: true,
            configured: true,
            mountLabel: 'media1',
            usedBytes: 1900 * 1024 ** 3,
            freeBytes: 100 * 1024 ** 3,
            nearlyFull: true,
          }),
        ]),
      ]),
    });
    await mockApi(page, state);
    await page.goto('/storage');
    await expect(page.getByLabel(/Portable USB Drive/)).toContainText('almost full');
  });

  test('unmounting stops the apps and then says it is safe to unplug', async ({ page }) => {
    const state = newState({
      storage: newStorage([
        systemDisk(),
        usbDisk([volume({ mounted: true, configured: true, mountLabel: 'media1' })]),
      ]),
    });
    await mockApi(page, state);
    await page.goto('/storage');

    await page.getByRole('button', { name: 'Unmount' }).click();
    await expect(page.getByRole('dialog')).toContainText('stopped first');
    await page.getByRole('button', { name: 'Stop apps and unmount' }).click();

    await expect(page.getByText('Safe to unplug.')).toBeVisible();
    expect(state.requests.find((r) => r.path.endsWith('/unmount'))?.body).toEqual({
      stopServices: true,
    });
  });

  test('shows the reason when a drive cannot be unmounted', async ({ page }) => {
    const state = newState({
      storage: newStorage([
        systemDisk(),
        usbDisk([volume({ mounted: true, configured: true, mountLabel: 'media1' })]),
      ]),
      failNextAction: {
        status: 409,
        error: 'in_use',
        message: 'The drive is still busy. Close anything using it and try again.',
      },
    });
    await mockApi(page, state);
    await page.goto('/storage');
    await page.getByRole('button', { name: 'Unmount' }).click();
    await page.getByRole('button', { name: 'Stop apps and unmount' }).click();
    await expect(page.getByRole('alert')).toContainText('still busy');
  });

  test('shows a health check result in plain words', async ({ page }) => {
    const state = newState({
      storage: newStorage([
        systemDisk(),
        usbDisk([volume({ mounted: true, configured: true, mountLabel: 'media1' })]),
      ]),
    });
    state.smart = {
      ...state.smart,
      warnings: ['The drive is running hot.'],
      temperatureCelsius: 66,
    };
    await mockApi(page, state);
    await page.goto('/storage');
    await page.getByRole('button', { name: 'Check health' }).click();
    await expect(page.getByRole('status')).toContainText('Needs attention');
    await expect(page.getByRole('status')).toContainText('running hot');
  });

  test('erasing needs the drive code typed, the password, and warns about data loss', async ({
    page,
  }) => {
    const state = newState({ reauthNeeded: true });
    await mockApi(page, state);
    await page.goto('/storage');

    await page.getByRole('button', { name: 'Erase and prepare as a new drive' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('cannot be recovered');
    await expect(dialog).toContainText('serial number WX12A3456789');
    const erase = dialog.getByRole('button', { name: 'Erase and prepare' });
    await expect(erase).toBeDisabled();

    await dialog.getByLabel('To confirm, type the drive code').fill('sda');
    await expect(erase).toBeDisabled();
    await dialog.getByLabel('To confirm, type the drive code').fill('sdb');
    await expect(erase).toBeEnabled();
    await erase.click();

    await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Password' }).fill('the right password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('status')).toContainText('Preparing the new drive');
    expect(state.requests.filter((r) => r.path.endsWith('/format'))).toHaveLength(2);
    expect(state.requests.at(-1)?.body).toEqual({
      diskId: '5ab1e0c0ffee0001',
      label: 'media1',
      confirmName: 'sdb',
    });
  });

  test('never offers to erase the system drive', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/storage');
    await expect(page.getByLabel(/Internal SSD/).getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Erase/ })).toHaveCount(1);
  });

  test('shows why a drive job failed and lets it be dismissed', async ({ page }) => {
    const storage = newStorage();
    storage.job = {
      kind: 'formatting',
      target: 'sdb',
      state: 'failed',
      message: 'The drive could not be prepared. Nothing was mounted.',
    };
    await mockApi(page, newState({ storage }));
    await page.goto('/storage');
    await expect(page.getByRole('alert')).toContainText('Nothing was mounted');
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('Nothing was mounted')).toBeHidden();
  });

  test('moves a library folder to a drive and offers to copy existing files', async ({ page }) => {
    const storage = newStorage([
      systemDisk(),
      usbDisk([volume({ mounted: true, configured: true, mountLabel: 'media1' })]),
    ]);
    storage.folders[0]!.hasLocalFiles = true;
    const state = newState({ storage });
    await mockApi(page, state);
    await page.goto('/storage');

    await expect(page.getByLabel('Library folders')).toContainText('main drive');
    await page.getByRole('button', { name: 'Change' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Where should Movies live?');
    await expect(page.getByLabel('Folder on that drive')).toHaveValue('Movies');
    await expect(page.getByLabel(/Copy the files already in Movies/)).toBeChecked();
    await page.getByRole('button', { name: 'Use this drive' }).click();

    await expect(page.getByLabel('Library folders')).toContainText('media1 / Movies');
    expect(state.requests.find((r) => r.path.endsWith('/assign'))?.body).toEqual({
      uuid: '22222222-2222-4222-8222-222222222222',
      subpath: 'Movies',
      copyExisting: true,
      stopServices: true,
    });
  });

  test('asks to set up a drive first when none is ready', async ({ page }) => {
    await mockApi(page, newState());
    await page.goto('/storage');
    await page.getByRole('button', { name: 'Change' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Set up a drive first');
  });

  test('flags a library folder whose drive is not connected', async ({ page }) => {
    const storage = newStorage();
    storage.folders[0] = {
      ...storage.folders[0]!,
      mapped: { mountLabel: 'media1', subpath: 'Movies' },
      volumeMissing: true,
    };
    await mockApi(page, newState({ storage }));
    await page.goto('/storage');
    await expect(page.getByLabel('Library folders').getByRole('alert')).toContainText(
      'not connected',
    );
  });

  test('tells you when a drive you set up is unplugged', async ({ page }) => {
    const storage = newStorage([systemDisk()]);
    storage.missing = [{ uuid: '22222222-2222-4222-8222-222222222222', mountLabel: 'media1' }];
    await mockApi(page, newState({ storage }));
    await page.goto('/storage');
    await expect(page.getByLabel('media1 is not connected')).toContainText('Plug it back in');
  });

  test('stays inside the screen on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockApi(page, newState());
    await page.goto('/storage');
    await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
    await page.getByRole('button', { name: 'Show details' }).first().click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
