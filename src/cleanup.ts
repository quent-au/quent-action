import * as core from '@actions/core';
import * as io from '@actions/io';
import * as path from 'path';

async function cleanup(): Promise<void> {
  try {
    core.info('🧹 Cleaning up Quent test artifacts...');

    const workDir = path.join(process.cwd(), '.quent-tests');
    
    try {
      await io.rmRF(workDir);
      core.info(`✅ Removed ${workDir}`);
    } catch (error) {
      core.warning(`Failed to remove work directory: ${error}`);
    }

    core.info('✅ Cleanup complete');
  } catch (error) {
    // Don't fail the action on cleanup errors
    if (error instanceof Error) {
      core.warning(`Cleanup warning: ${error.message}`);
    }
  }
}

cleanup();


