import { test } from 'bun:test';
import { verifyRelease } from '../.changeset/bun-lock';

test('the release train has one stable Bun/Cargo/Tauri version and consistent locks', async () => {
  await verifyRelease();
});
