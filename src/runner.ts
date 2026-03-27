import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

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
      exitCode = await exec.exec(
        'npx',
        [
          'playwright',
          'test',
          '--reporter=line,json',
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
    ['html', { outputFolder: '${resultsDir}/html-report' }],
    ['json', { outputFile: '${resultsDir}/results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
    trace: 'on',
    screenshot: 'on',
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
    const quentReportFile = path.join(resultsDir, 'quent-report.json');
    
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
            await this.parseSuite(suite, tests, failures, resultsDir);
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

    return {
      status: failed > 0 ? 'failed' : 'passed',
      passed,
      failed,
      duration,
      tests,
      failures,
    };
  }

  private async parseSuite(
    suite: any,
    tests: TestInfo[],
    failures: TestFailure[],
    resultsDir: string
  ): Promise<void> {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const lastResult = test.results?.[test.results.length - 1];
        const testId = spec.id || spec.title;
        const testName = `${suite.title} > ${spec.title}`;
        const duration = lastResult?.duration || 0;

        let steps = this.extractTraceScreenshots(lastResult, resultsDir);
        if (steps.length === 0) {
          steps = this.extractAttachments(lastResult);
        }

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
      await this.parseSuite(nestedSuite, tests, failures, resultsDir);
    }
  }

  private extractTraceScreenshots(result: any, resultsDir: string): StepCapture[] {
    const steps: StepCapture[] = [];
    if (!result?.attachments) return steps;

    const traceAttachment = result.attachments.find(
      (a: any) => a.name === 'trace' && a.path
    );
    if (!traceAttachment?.path || !fs.existsSync(traceAttachment.path)) return steps;

    try {
      const zip = new AdmZip(traceAttachment.path);
      const entries = zip.getEntries();

      // Parse trace events from all .trace files
      const traceFiles = entries.filter(e => e.entryName.endsWith('.trace'));

      // Collect actions (before/after pairs) and screencast frames
      const beforeEvents = new Map<string, { apiName: string; wallTime: number }>();
      const actions: Array<{ apiName: string; endTime: number; callId: string }> = [];
      const frames: Array<{ sha1: string; timestamp: number }> = [];

      for (const traceFile of traceFiles) {
        const content = traceFile.getData().toString('utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === 'before' && event.callId && event.apiName) {
              beforeEvents.set(event.callId, {
                apiName: event.apiName,
                wallTime: event.wallTime || event.startTime || 0,
              });
            }

            if (event.type === 'after' && event.callId) {
              const before = beforeEvents.get(event.callId);
              if (before) {
                actions.push({
                  apiName: before.apiName,
                  endTime: event.wallTime || event.endTime || before.wallTime || 0,
                  callId: event.callId,
                });
              }
            }

            if (event.type === 'screencast-frame' && event.sha1) {
              frames.push({
                sha1: event.sha1,
                timestamp: event.timestamp || 0,
              });
            }
          } catch { /* skip malformed lines */ }
        }
      }

      // Filter to only user-facing actions (skip internal ones)
      const userActions = actions.filter(a =>
        !a.apiName.startsWith('tracing.') &&
        !a.apiName.startsWith('browserContext.') &&
        !a.apiName.startsWith('browser.')
      );

      core.info(`  Trace: ${userActions.length} actions, ${frames.length} screencast frames`);

      if (userActions.length === 0 || frames.length === 0) return steps;

      // Sort frames by timestamp
      frames.sort((a, b) => a.timestamp - b.timestamp);

      // Extract PNGs from zip resources
      const extractDir = path.join(resultsDir, `trace-screenshots-${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });

      const pngEntries = entries.filter(
        e => e.entryName.startsWith('resources/') && e.entryName.endsWith('.png')
      );
      const shaToPath = new Map<string, string>();
      for (const entry of pngEntries) {
        const sha = path.basename(entry.entryName, '.png');
        const outPath = path.join(extractDir, `${sha}.png`);
        fs.writeFileSync(outPath, entry.getData());
        shaToPath.set(sha, outPath);
      }

      // For each action, find the screencast frame closest AFTER the action ended
      const usedFrameIndices = new Set<number>();

      for (const action of userActions) {
        let bestIdx = -1;
        let bestDelta = Infinity;

        for (let i = 0; i < frames.length; i++) {
          if (usedFrameIndices.has(i)) continue;
          const delta = frames[i].timestamp - action.endTime;
          if (delta >= 0 && delta < bestDelta) {
            bestDelta = delta;
            bestIdx = i;
          }
        }

        // If no frame after, take the closest frame before
        if (bestIdx === -1) {
          for (let i = frames.length - 1; i >= 0; i--) {
            if (usedFrameIndices.has(i)) continue;
            if (frames[i].timestamp <= action.endTime) {
              bestIdx = i;
              break;
            }
          }
        }

        if (bestIdx >= 0) {
          const frame = frames[bestIdx];
          const screenshotPath = shaToPath.get(frame.sha1);
          if (screenshotPath) {
            usedFrameIndices.add(bestIdx);
            steps.push({
              stepIndex: steps.length,
              stepName: action.apiName,
              screenshotPath,
              consoleMessages: [],
              networkErrors: [],
            });
          }
        }
      }

      core.info(`  Extracted ${steps.length} step screenshots from trace`);
    } catch (error) {
      core.warning(`Failed to extract trace screenshots: ${error}`);
    }

    return steps;
  }

  private extractAttachments(result: any): StepCapture[] {
    const steps: StepCapture[] = [];
    if (!result?.attachments) return steps;

    for (const attachment of result.attachments) {
      if (attachment.contentType?.includes('image')) {
        steps.push({
          stepIndex: steps.length,
          stepName: attachment.name,
          screenshotPath: attachment.path || '',
          consoleMessages: [],
          networkErrors: [],
        });
      }
    }
    return steps;
  }
}



