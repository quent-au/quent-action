import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';

interface RunnerOptions {
  testsDir: string;
  baseUrl: string;
  browser: string;
  retries: number;
  apiKey: string;
  apiUrl?: string;
}

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

export class TestRunner {
  private options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  async run(): Promise<RunResults> {
    const { testsDir, baseUrl, browser, retries } = this.options;
    const resultsDir = path.join(testsDir, 'test-results');

    // Create playwright config if it doesn't exist
    const configPath = path.join(testsDir, 'playwright.config.ts');
    if (!fs.existsSync(configPath)) {
      await this.createPlaywrightConfig(configPath, baseUrl, browser, retries, resultsDir);
    }

    // Install dependencies
    const packageJsonPath = path.join(testsDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      await exec.exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: testsDir });
    }

    // Run playwright tests
    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    try {
      exitCode = await exec.exec(
        'npx',
        [
          'playwright',
          'test',
          '--reporter=json,html',
          `--output=${resultsDir}`,
        ],
        {
          cwd: testsDir,
          env: {
            ...process.env,
            BASE_URL: baseUrl,
            QUENT_API_KEY: this.options.apiKey,
            QUENT_API_URL: this.options.apiUrl || 'https://quent-service.vercel.app',
            PWTEST_SKIP_TEST_OUTPUT: '1',
          },
          ignoreReturnCode: true,
          listeners: {
            stdout: (data) => {
              stdout += data.toString();
            },
            stderr: (data) => {
              stderr += data.toString();
            },
          },
        }
      );
    } catch (error) {
      core.warning(`Test execution error: ${error}`);
    }

    // Parse results
    const results = await this.parseResults(testsDir, resultsDir);
    
    return results;
  }

  private async createPlaywrightConfig(
    configPath: string,
    baseUrl: string,
    browser: string,
    retries: number,
    resultsDir: string
  ): Promise<void> {
    const config = `
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: ${retries},
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: '${resultsDir}/html-report' }],
    ['json', { outputFile: '${resultsDir}/results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'on-first-retry',
  },
  outputDir: '${resultsDir}',
  projects: [
    {
      name: '${browser}',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;
    fs.writeFileSync(configPath, config);
    core.info(`Created Playwright config at ${configPath}`);
  }

  private async parseResults(testsDir: string, resultsDir: string): Promise<RunResults> {
    const resultsFile = path.join(resultsDir, 'results.json');
    
    // Check if quent-report.json exists (from custom reporter)
    const quentReportFile = path.join(resultsDir, 'quent-report.json');
    
    let passed = 0;
    let failed = 0;
    let duration = 0;
    const failures: TestFailure[] = [];

    // Try to read Playwright's JSON report
    if (fs.existsSync(resultsFile)) {
      try {
        const rawData = fs.readFileSync(resultsFile, 'utf-8');
        const data = JSON.parse(rawData);

        // Parse Playwright JSON report format
        if (data.suites) {
          for (const suite of data.suites) {
            await this.parseSuite(suite, failures, resultsDir);
          }
        }

        passed = data.stats?.expected || 0;
        failed = data.stats?.unexpected || 0;
        duration = data.stats?.duration || 0;
      } catch (error) {
        core.warning(`Failed to parse results.json: ${error}`);
      }
    }

    // Also try quent-report.json
    if (fs.existsSync(quentReportFile)) {
      try {
        const rawData = fs.readFileSync(quentReportFile, 'utf-8');
        const quentData = JSON.parse(rawData);

        for (const test of quentData.tests || []) {
          if (test.status === 'failed' || test.status === 'timedOut') {
            failures.push({
              testId: test.testId,
              testName: test.testName,
              error: test.error?.message || 'Unknown error',
              stack: test.error?.stack || '',
              steps: test.steps || [],
              duration: test.duration || 0,
            });
          }
        }

        if (quentData.tests) {
          passed = quentData.tests.filter((t: any) => t.status === 'passed').length;
          failed = quentData.tests.filter((t: any) => t.status !== 'passed').length;
        }
      } catch (error) {
        core.warning(`Failed to parse quent-report.json: ${error}`);
      }
    }

    // Find screenshots in results directory
    await this.collectScreenshots(resultsDir, failures);

    return {
      status: failed > 0 ? 'failed' : 'passed',
      passed,
      failed,
      duration,
      failures,
    };
  }

  private async parseSuite(
    suite: any,
    failures: TestFailure[],
    resultsDir: string
  ): Promise<void> {
    // Process specs in this suite
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const lastResult = test.results?.[test.results.length - 1];
        
        if (test.status === 'unexpected' || test.status === 'flaky') {
          const failure: TestFailure = {
            testId: spec.id || spec.title,
            testName: `${suite.title} > ${spec.title}`,
            error: lastResult?.error?.message || 'Test failed',
            stack: lastResult?.error?.stack || '',
            steps: [],
            duration: lastResult?.duration || 0,
          };

          // Extract step info from attachments
          if (lastResult?.attachments) {
            for (const attachment of lastResult.attachments) {
              if (attachment.contentType?.includes('image')) {
                failure.steps.push({
                  stepIndex: failure.steps.length,
                  stepName: attachment.name,
                  screenshotPath: attachment.path || '',
                  consoleMessages: [],
                  networkErrors: [],
                });
              }
            }
          }

          failures.push(failure);
        }
      }
    }

    // Recurse into nested suites
    for (const nestedSuite of suite.suites || []) {
      await this.parseSuite(nestedSuite, failures, resultsDir);
    }
  }

  private async collectScreenshots(
    resultsDir: string,
    failures: TestFailure[]
  ): Promise<void> {
    if (!fs.existsSync(resultsDir)) {
      return;
    }

    // Walk through results directory to find screenshots
    const walkDir = (dir: string): string[] => {
      const files: string[] = [];
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            files.push(...walkDir(fullPath));
          } else if (entry.name.endsWith('.png') || entry.name.endsWith('.jpg')) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Ignore errors reading directories
      }

      return files;
    };

    const screenshots = walkDir(resultsDir);
    
    // Associate screenshots with failures if they don't have any
    for (const failure of failures) {
      if (failure.steps.length === 0) {
        // Find screenshots that might belong to this test
        const testScreenshots = screenshots.filter((s) => {
          const name = path.basename(s).toLowerCase();
          const testName = failure.testName.toLowerCase().replace(/[^a-z0-9]/g, '-');
          return name.includes(testName) || name.includes(failure.testId);
        });

        for (let i = 0; i < testScreenshots.length; i++) {
          failure.steps.push({
            stepIndex: i,
            stepName: path.basename(testScreenshots[i]),
            screenshotPath: testScreenshots[i],
            consoleMessages: [],
            networkErrors: [],
          });
        }
      }
    }
  }
}



