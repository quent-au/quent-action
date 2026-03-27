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
  projectId: string;
  prNumber: number;
  branch: string;
  repo: string;
  sha: string;
  runId: string;
  debugTests: boolean;
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

export class TestRunner {
  private options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
  }

  async run(): Promise<RunResults> {
    const { testsDir, baseUrl, browser, retries } = this.options;
    const resultsDir = path.join(testsDir, 'test-results');

    this.copyQuentReporter(testsDir);

    const configPath = path.join(testsDir, 'playwright.config.ts');
    await this.createPlaywrightConfig(configPath, baseUrl, browser, retries, resultsDir);

    const packageJsonPath = path.join(testsDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      core.info('Installing test dependencies...');
      await exec.exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: testsDir });
    } else {
      core.warning(`No package.json found in ${testsDir}`);
    }

    const testFiles = this.findTestFiles(testsDir);
    if (testFiles.length === 0) {
      core.error(`No test files found in ${testsDir}`);
      core.info(`Directory contents of ${testsDir}:`);
      this.logDirectoryTree(testsDir, '  ');
      return { status: 'failed', passed: 0, failed: 0, duration: 0, tests: [] , failures: [] };
    }

    core.info(`Found ${testFiles.length} test file(s):`);
    for (const f of testFiles) {
      core.info(`  ${path.relative(testsDir, f)}`);
    }

    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    const resultsJsonPath = path.join(resultsDir, 'results.json');

    core.info(`Starting Playwright (browser=${browser}, baseUrl=${baseUrl})...`);

    try {
      const o = this.options;
      exitCode = await exec.exec(
        'npx',
        [
          'playwright',
          'test',
          `--output=${resultsDir}`,
        ],
        {
          cwd: testsDir,
          env: {
            ...process.env,
            BASE_URL: baseUrl,
            QUENT_API_KEY: this.options.apiKey,
            QUENT_API_URL: this.options.apiUrl || 'https://quent-service.vercel.app',
            QUENT_PROJECT_ID: o.projectId,
            QUENT_PR_NUMBER: String(o.prNumber),
            QUENT_BRANCH: o.branch,
            QUENT_REPO: o.repo,
            QUENT_SHA: o.sha,
            QUENT_RUN_ID: o.runId,
            QUENT_TRIGGER_TYPE: 'PR',
            QUENT_PLATFORM: 'web',
            QUENT_DEBUG_TESTS: o.debugTests ? 'true' : 'false',
            QUENT_TEST_RESULTS_DIR: resultsDir,
            PWTEST_SKIP_TEST_OUTPUT: '1',
            PLAYWRIGHT_JSON_OUTPUT_NAME: resultsJsonPath,
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
      core.error(`Test execution threw an exception: ${error}`);
    }

    core.info(`Playwright exited with code ${exitCode}`);

    if (stderr.trim()) {
      core.warning(`Playwright stderr:\n${stderr.trim()}`);
    }

    core.info(`Contents of results directory (${resultsDir}):`);
    this.logDirectoryTree(resultsDir, '  ');

    const results = await this.parseResults(testsDir, resultsDir);

    core.info(`Test results: ${results.passed} passed, ${results.failed} failed (${results.duration}ms)`);
    for (const t of results.tests) {
      core.info(`  ${t.testName}: ${t.status} — ${t.steps.length} step(s)`);
      for (const s of t.steps) {
        core.info(`    [${s.stepIndex}] ${s.stepName} → ${s.screenshotPath || '(no path)'}`);
      }
    }
    
    return results;
  }

  private findTestFiles(dir: string): string[] {
    const files: string[] = [];
    const walk = (d: string) => {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.name === 'node_modules') continue;
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(spec|test)\.(ts|js|mjs)$/.test(entry.name)) {
            files.push(full);
          }
        }
      } catch { /* ignore */ }
    };
    walk(dir);
    return files;
  }

  private logDirectoryTree(dir: string, indent: string, depth = 0): void {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        core.info(`${indent}${entry.isDirectory() ? entry.name + '/' : entry.name}`);
        if (entry.isDirectory()) {
          this.logDirectoryTree(full, indent + '  ', depth + 1);
        }
      }
    } catch { /* ignore */ }
  }

  /** Ship Playwright reporter that reads attachment path/body and POSTs to Quent (same idea as example-sample-ecommerce-tests). */
  private copyQuentReporter(testsDir: string): void {
    const src = path.join(__dirname, 'quent-reporter.ts');
    if (!fs.existsSync(src)) {
      core.warning(
        `Quent reporter not found at ${src} — rebuild action with cp quent-reporter.ts to dist`
      );
      return;
    }
    const dest = path.join(testsDir, 'quent-reporter.ts');
    fs.copyFileSync(src, dest);
    core.info(`Copied Quent Playwright reporter to ${dest}`);
  }

  private async createPlaywrightConfig(
    configPath: string,
    baseUrl: string,
    browser: string,
    retries: number,
    resultsDir: string
  ): Promise<void> {
    const testsDir = path.dirname(configPath);
    const testDir = this.detectTestDir(testsDir);
    core.info(`Using testDir: ${testDir}`);

    const config = `
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '${testDir}',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: ${retries},
  workers: 1,
  reporter: [
    ['line'],
    ['html', { outputFolder: '${resultsDir}/html-report' }],
    ['json', { outputFile: '${resultsDir}/results.json' }],
    ['./quent-reporter.ts'],
  ],
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
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

  private detectTestDir(testsDir: string): string {
    for (const candidate of ['tests', 'specs', 'e2e', '.']) {
      const dir = path.join(testsDir, candidate);
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir);
          if (entries.some(e => /\.(spec|test)\.(ts|js|mjs)$/.test(e))) {
            return `./${candidate}`;
          }
        } catch { /* ignore */ }
      }
    }
    return '.';
  }

  private async parseResults(testsDir: string, resultsDir: string): Promise<RunResults> {
    const resultsFile = path.join(resultsDir, 'results.json');

    let passed = 0;
    let failed = 0;
    let duration = 0;
    const tests: TestInfo[] = [];
    const failures: TestFailure[] = [];

    if (fs.existsSync(resultsFile)) {
      core.info(`Found results file: ${resultsFile}`);
      try {
        const rawData = fs.readFileSync(resultsFile, 'utf-8');
        const data = JSON.parse(rawData);

        if (data.suites) {
          for (const suite of data.suites) {
            this.parseSuite(suite, tests, failures);
          }
        }

        passed = data.stats?.expected || 0;
        failed = data.stats?.unexpected || 0;
        duration = data.stats?.duration || 0;
      } catch (error) {
        core.warning(`Failed to parse results.json: ${error}`);
      }
    } else {
      core.warning(`Results file not found at ${resultsFile} — Playwright may not have run any tests`);
    }

    return {
      status: failed > 0 ? 'failed' : 'passed',
      passed,
      failed,
      duration,
      tests,
      failures,
    };
  }

  private parseSuite(
    suite: any,
    tests: TestInfo[],
    failures: TestFailure[],
  ): void {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const lastResult = test.results?.[test.results.length - 1];
        const testId = spec.id || spec.title;
        const testName = `${suite.title} > ${spec.title}`;
        const duration = lastResult?.duration || 0;

        const steps = this.extractAttachments(lastResult);
        core.info(`  Parsed "${testName}": ${test.status}, ${steps.length} step(s)`);

        if (test.status === 'expected') {
          tests.push({ testId, testName, status: 'passed', duration, steps });
        } else if (test.status === 'unexpected' || test.status === 'flaky') {
          const status = test.status === 'flaky' ? 'flaky' as const : 'failed' as const;
          tests.push({ testId, testName, status, duration, steps });

          failures.push({
            testId,
            testName,
            error: lastResult?.error?.message || 'Test failed',
            stack: lastResult?.error?.stack || '',
            steps,
            duration,
          });
        } else if (test.status === 'skipped') {
          tests.push({ testId, testName, status: 'skipped', duration, steps: [] });
        }
      }
    }

    for (const nestedSuite of suite.suites || []) {
      this.parseSuite(nestedSuite, tests, failures);
    }
  }

  /** Paths from results.json when present (Quent reporter reads live attachment bodies during the run). */
  private extractAttachments(result: any): StepCapture[] {
    const steps: StepCapture[] = [];
    if (!result?.attachments) return steps;

    const BUILTIN_NAMES = new Set(['screenshot', 'trace', 'video']);

    for (const attachment of result.attachments) {
      if (!attachment.contentType?.includes('image')) continue;
      if (BUILTIN_NAMES.has(attachment.name)) continue;

      if (attachment.path && fs.existsSync(attachment.path)) {
        steps.push({
          stepIndex: steps.length,
          stepName: attachment.name,
          screenshotPath: attachment.path,
          consoleMessages: [],
          networkErrors: [],
        });
      }
    }
    return steps;
  }
}
