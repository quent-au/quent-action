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

interface RunResults {
  status: 'passed' | 'failed';
  passed: number;
  failed: number;
  duration: number;
  failures: TestFailure[];
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
  analysisId: string;
  diffUrl: string;
}

export class FailureReporter {
  private api: QuentiApi;

  constructor(api: QuentiApi) {
    this.api = api;
  }

  async createReport(params: CreateReportParams): Promise<ReportResult> {
    const { projectId, prNumber, branch, repo, sha, runId, results, testsDir } = params;

    core.info(`Creating failure report for ${results.failures.length} failed tests`);

    // Convert screenshots to base64 and prepare report
    const tests = await Promise.all(
      results.failures.map(async (failure) => {
        const steps = await Promise.all(
          failure.steps.map(async (step) => {
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
              consoleMessages: step.consoleMessages,
              networkErrors: step.networkErrors,
            };
          })
        );

        return {
          testId: failure.testId,
          testName: failure.testName,
          status: 'failed',
          duration: failure.duration,
          error: {
            message: failure.error,
            stack: failure.stack,
          },
          steps,
          retryCount: 1,
        };
      })
    );

    // Also try to collect trace files
    const traceFiles = await this.collectTraceFiles(testsDir);
    
    // Upload to Quent API
    const response = await this.api.uploadFailure({
      projectId,
      prNumber,
      branch,
      repo,
      sha,
      runId,
      report: {
        status: results.status,
        duration: results.duration,
        tests,
      },
    });

    return {
      analysisId: response.analysisId,
      diffUrl: response.diffUrl,
    };
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


