import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
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
  screenshot: string;
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

  /**
   * Test run data is uploaded by `quent-reporter.ts` during Playwright (same as example-sample-ecommerce-tests).
   * This step only reads `quent-upload-result.json` and optionally creates failure analysis.
   */
  async createReport(params: CreateReportParams): Promise<ReportResult> {
    const { projectId, prNumber, branch, repo, sha, runId, results, testsDir } = params;

    core.info(
      `Reporting: ${results.passed} passed, ${results.failed} failed (Playwright reporter is the source of test run upload)`
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

    core.info(`Test run from reporter: ${uploaded.testRunId}`);

    return this.finishAfterReporterUpload({
      projectId,
      prNumber,
      branch,
      repo,
      sha,
      runId,
      results,
      testRunId: uploaded.testRunId,
      diffUrl: uploaded.diffUrl || `https://app.quent.ai/test-run/${uploaded.testRunId}`,
    });
  }

  private async finishAfterReporterUpload(args: {
    projectId: string;
    prNumber: number;
    branch: string;
    repo: string;
    sha: string;
    runId: string;
    results: RunResults;
    testRunId: string;
    diffUrl: string;
  }): Promise<ReportResult> {
    const { projectId, prNumber, branch, repo, sha, runId, results, testRunId, diffUrl } = args;

    let analysisId: string | undefined;
    if (results.failed > 0) {
      core.info('Creating failure analysis...');
      const testsMetadata = this.prepareTestMetadata(results);
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
      testRunId,
      analysisId,
      diffUrl: analysisId ? `https://app.quent.ai/analysis/${analysisId}` : diffUrl,
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
