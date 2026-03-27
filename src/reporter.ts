import * as core from '@actions/core';
import * as fs from 'fs';
import { QuentiApi } from './api';

interface TestFailure {
  testId: string;
  testName: string;
  error: string;
  stack: string;
  steps: StepCapture[];
  duration: number;
}

interface StepCapture {
  stepIndex: number;
  stepName: string;
  screenshotPath: string;
  consoleMessages: Array<{ type: string; text: string; timestamp: number }>;
  networkErrors: Array<{ url: string; status: number; statusText: string; method: string }>;
}

interface TestInfo {
  testId: string;
  testName: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky';
  duration: number;
  steps: StepCapture[];
}

interface RunResults {
  status: 'passed' | 'failed';
  passed: number;
  failed: number;
  duration: number;
  tests: TestInfo[];
  failures: TestFailure[];
}

// Prepared test result with base64 screenshots (for API)
interface PreparedTestResult {
  testId: string;
  testName: string;
  status: string;
  duration: number;
  retryCount: number;
  error?: { message: string; stack: string };
  steps: PreparedStep[];
}

interface PreparedStep {
  stepIndex: number;
  stepName: string;
  screenshot: string; // base64
  consoleMessages: Array<{ type: string; text: string; timestamp: number }>;
  networkErrors: Array<{ url: string; status: number; statusText: string; method: string }>;
}

interface CreateReportParams {
  projectId: string;
  prNumber: number;
  branch: string;
  repo: string;
  sha: string;
  runId: string;
  results: RunResults;
  testsDir: string;
}

interface ReportResult {
  analysisId?: string;
  testRunId?: string;
  diffUrl: string;
}

export class FailureReporter {
  private api: QuentiApi;

  constructor(api: QuentiApi) {
    this.api = api;
  }

  async createReport(params: CreateReportParams): Promise<ReportResult> {
    const { projectId, prNumber, branch, repo, sha, runId, results } = params;

    core.info(`Creating test run report: ${results.passed} passed, ${results.failed} failed`);

    const totalSteps = results.tests.reduce((sum, t) => sum + t.steps.length, 0);
    core.info(`Total steps across all tests: ${totalSteps}`);

    // Phase 1: Upload test metadata (no screenshots) to create the run and get step IDs
    core.info('Phase 1: Uploading test metadata...');
    const testsMetadata = this.prepareTestMetadata(results);
    core.info(`Prepared metadata for ${testsMetadata.length} tests (${testsMetadata.reduce((s, t) => s + t.steps.length, 0)} steps)`);

    const response = await this.api.uploadTestRun({
      projectId,
      prNumber,
      branch,
      repo,
      sha,
      runId,
      triggerType: 'PR',
      tests: testsMetadata,
    });

    core.info(`Test run created: ${response.testRunId}`);
    core.info(`Received ${response.testResults.length} test result(s) with step IDs`);

    // Phase 2: Upload screenshots one-by-one using the returned step IDs
    core.info('Phase 2: Uploading screenshots...');
    const stepIdMap = new Map<string, string>();
    for (const tr of response.testResults) {
      core.info(`  ${tr.testName}: ${tr.steps.length} step(s)`);
      for (const step of tr.steps) {
        if (step.id) {
          stepIdMap.set(`${tr.testName}::${step.stepIndex}`, step.id);
        }
      }
    }
    core.info(`Step ID map has ${stepIdMap.size} entries`);

    let uploadedCount = 0;
    let skippedCount = 0;
    let totalScreenshots = 0;

    for (const test of results.tests) {
      for (const step of test.steps) {
        if (!step.screenshotPath) {
          core.info(`  [skip] ${test.testName} step ${step.stepIndex}: no screenshot path`);
          skippedCount++;
          continue;
        }
        if (!fs.existsSync(step.screenshotPath)) {
          core.warning(`  [skip] ${test.testName} step ${step.stepIndex}: file not found at ${step.screenshotPath}`);
          skippedCount++;
          continue;
        }
        totalScreenshots++;

        const stepId = stepIdMap.get(`${test.testName}::${step.stepIndex}`);
        if (!stepId) {
          core.warning(`  [skip] No step ID for "${test.testName}::${step.stepIndex}"`);
          continue;
        }

        try {
          const buffer = fs.readFileSync(step.screenshotPath);
          const sizeKB = Math.round(buffer.length / 1024);
          core.info(`  Uploading ${test.testName} step ${step.stepIndex} (${sizeKB} KB)...`);

          const base64 = buffer.toString('base64');
          await this.api.uploadStepScreenshot({
            testRunId: response.testRunId,
            stepId,
            screenshot: base64,
          });
          uploadedCount++;
          core.info(`  ✓ Uploaded`);
        } catch (error) {
          core.warning(`  ✗ Failed to upload screenshot for ${test.testName} step ${step.stepIndex}: ${error}`);
        }
      }
    }

    core.info(`Screenshot upload complete: ${uploadedCount} uploaded, ${skippedCount} skipped, ${totalScreenshots} total on disk`);

    // If there are failures, also create an analysis for review
    let analysisId: string | undefined;
    if (results.failed > 0) {
      core.info('Creating failure analysis...');
      const failedTests = testsMetadata.filter(t => t.status === 'failed');
      const analysisResponse = await this.api.uploadFailure({
        projectId,
        prNumber,
        branch,
        repo,
        sha,
        runId,
        report: {
          status: results.status,
          duration: results.duration,
          tests: failedTests,
        },
      });
      analysisId = analysisResponse.analysisId;
      core.info(`Analysis created: ${analysisId}`);
    }

    return {
      testRunId: response.testRunId,
      analysisId,
      diffUrl: response.diffUrl || (analysisId ? `https://app.quent.ai/analysis/${analysisId}` : `https://app.quent.ai/test-run/${response.testRunId}`),
    };
  }

  private prepareTestMetadata(results: RunResults): PreparedTestResult[] {
    const failureMap = new Map<string, TestFailure>();
    for (const f of results.failures) {
      failureMap.set(f.testId, f);
    }

    return results.tests.map((test) => {
      const failure = failureMap.get(test.testId);

      const steps: PreparedStep[] = test.steps.map((step) => ({
        stepIndex: step.stepIndex,
        stepName: step.stepName,
        screenshot: '',
        consoleMessages: step.consoleMessages || [],
        networkErrors: step.networkErrors || [],
      }));

      if (failure) {
        return {
          testId: test.testId,
          testName: test.testName,
          status: test.status === 'flaky' ? 'flaky' : 'failed',
          duration: test.duration,
          retryCount: 1,
          error: { message: failure.error, stack: failure.stack },
          steps,
        };
      }

      return {
        testId: test.testId,
        testName: test.testName,
        status: test.status,
        duration: test.duration,
        retryCount: 0,
        steps,
      };
    });
  }

}



