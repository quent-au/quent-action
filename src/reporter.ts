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
    const { projectId, prNumber, branch, repo, sha, runId, results, testsDir } = params;

    core.info(`Creating test run report: ${results.passed} passed, ${results.failed} failed`);

    // Convert screenshots to base64 and prepare ALL tests (passed + failed)
    const tests = await this.prepareTestResults(results);

    // Upload to Quent API via test-runs endpoint (reports ALL results)
    const response = await this.api.uploadTestRun({
      projectId,
      prNumber,
      branch,
      repo,
      sha,
      runId,
      triggerType: 'PR',
      tests,
    });

    // If there are failures, also create an analysis for review
    let analysisId: string | undefined;
    if (results.failed > 0) {
      const failedTests = tests.filter(t => t.status === 'failed');
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
    }

    return {
      testRunId: response.testRunId,
      analysisId,
      diffUrl: response.diffUrl || (analysisId ? `https://app.quent.ai/analysis/${analysisId}` : `https://app.quent.ai/test-run/${response.testRunId}`),
    };
  }

  private async prepareTestResults(results: RunResults): Promise<PreparedTestResult[]> {
    const failureMap = new Map<string, TestFailure>();
    for (const f of results.failures) {
      failureMap.set(f.testId, f);
    }

    const prepared = await Promise.all(
      results.tests.map(async (test) => {
        const failure = failureMap.get(test.testId);
        const steps = await this.prepareSteps(test.steps);

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
      })
    );

    return prepared;
  }

  private async prepareSteps(steps: StepCapture[]): Promise<PreparedStep[]> {
    return Promise.all(
      steps.map(async (step) => {
        let screenshotBase64 = '';

        if (step.screenshotPath && fs.existsSync(step.screenshotPath)) {
          try {
            const buffer = fs.readFileSync(step.screenshotPath);
            screenshotBase64 = buffer.toString('base64');
          } catch (error) {
            core.warning(`Failed to read screenshot: ${step.screenshotPath}`);
          }
        }

        return {
          stepIndex: step.stepIndex,
          stepName: step.stepName,
          screenshot: screenshotBase64,
          consoleMessages: step.consoleMessages || [],
          networkErrors: step.networkErrors || [],
        };
      })
    );
  }

  private async collectTraceFiles(testsDir: string): Promise<string[]> {
    const traces: string[] = [];
    const resultsDir = path.join(testsDir, 'test-results');

    if (!fs.existsSync(resultsDir)) {
      return traces;
    }

    const walkDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (entry.name.endsWith('.zip') && entry.name.includes('trace')) {
            traces.push(fullPath);
          }
        }
      } catch (error) {
        // Ignore errors
      }
    };

    walkDir(resultsDir);
    return traces;
  }
}



