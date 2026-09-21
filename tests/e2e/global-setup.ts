import * as fs from 'fs';
import * as path from 'path';

const REPOS_ROOT = path.join(process.env.USERPROFILE || 'C:/Users/User', 'Documents', 'openhub', 'repos');

export default async function globalSetup(): Promise<void> {
  // The test database is reset by dev:test before the isolated server starts.
  // Clean the shared repository worktree left by a preceding E2E run.
  const sharedRepoDir = path.join(REPOS_ROOT, 'e2eshared');
  if (fs.existsSync(sharedRepoDir)) {
    try {
      fs.rmSync(sharedRepoDir, { recursive: true, force: true });
    } catch (err: any) {
      console.warn(`[globalSetup] Could not clean shared repo dir: ${err.message}`);
    }
  }
}
