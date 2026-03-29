import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

interface ReadReportParams {
  testsDir: string;
}

export interface QuentUploadSummary {
  testRunId: string;
  testRunUrl: string;
}

/**
 * Reads `quent-upload-result.json` written by `quent-reporter.ts` during Playwright.
 * Test run payload (including screenshots) is uploaded by the reporter only — triage in Quent App.
 */
export function readQuentUploadResult(params: ReadReportParams): QuentUploadSummary {
  const { testsDir } = params;

  core.info(
    `Reporting: test run uploaded by Playwright reporter (see ${path.join(testsDir, 'test-results', 'quent-upload-result.json')})`
  );

  const reporterResultPath = path.join(testsDir, 'test-results', 'quent-upload-result.json');
  if (!fs.existsSync(reporterResultPath)) {
    throw new Error(
      `Missing ${reporterResultPath}. The Quent Playwright reporter must run and write quent-upload-result.json.`
    );
  }

  let uploaded: { success?: boolean; testRunId?: string; diffUrl?: string; error?: string };
  try {
    uploaded = JSON.parse(fs.readFileSync(reporterResultPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Invalid quent-upload-result.json: ${e}`);
  }

  if (!uploaded.success || !uploaded.testRunId) {
    throw new Error(
      `Quent Playwright reporter did not upload successfully: ${uploaded.error || JSON.stringify(uploaded)}`
    );
  }

  const testRunUrl = uploaded.diffUrl || `https://app.quent.ai/test-run/${uploaded.testRunId}`;
  core.info(`Test run id: ${uploaded.testRunId}`);
  core.info(`Open in Quent: ${testRunUrl}`);

  return {
    testRunId: uploaded.testRunId,
    testRunUrl,
  };
}
