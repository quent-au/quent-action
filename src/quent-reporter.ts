/**
 * Playwright reporter: reads attachment path/body (like local runs), POSTs test run with base64 steps.
 * Used in CI by quent-action — copied next to tests before `playwright test`.
 */
import * as fs from 'fs';
import * as path from 'path';

interface ReporterConfig {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  branch: string;
  platform: string;
  triggerType: string;
  prNumber: string;
  repo: string;
  sha: string;
  runId: string;
  debugTests: string;
}

function loadConfig(): ReporterConfig {
  return {
    apiUrl: process.env.QUENT_API_URL || 'https://quent-service.vercel.app',
    apiKey: process.env.QUENT_API_KEY || '',
    projectId: process.env.QUENT_PROJECT_ID || '',
    branch: process.env.QUENT_BRANCH || 'main',
    platform: process.env.QUENT_PLATFORM || 'web',
    triggerType: process.env.QUENT_TRIGGER_TYPE || 'PR',
    prNumber: process.env.QUENT_PR_NUMBER || '0',
    repo: process.env.QUENT_REPO || '',
    sha: process.env.QUENT_SHA || '',
    runId: process.env.QUENT_RUN_ID || '',
    debugTests: process.env.QUENT_DEBUG_TESTS !== 'false' ? 'true' : 'false',
  };
}

function writeUploadResult(payload: {
  success: boolean;
  testRunId?: string;
  diffUrl?: string;
  error?: string;
}): void {
  const dir = process.env.QUENT_TEST_RESULTS_DIR || 'test-results';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'quent-upload-result.json');
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[Quent Reporter] Wrote ${out}`);
  } catch (e) {
    console.error('[Quent Reporter] Failed to write quent-upload-result.json:', e);
  }
}

class QuentReporter {
  private config: ReporterConfig;
  private tests: any[] = [];
  private startTime: number = Date.now();

  constructor(_options: Record<string, unknown>) {
    this.config = loadConfig();
    console.log('[Quent Reporter] Initializing:', {
      apiUrl: this.config.apiUrl,
      projectId: this.config.projectId,
      branch: this.config.branch,
      hasApiKey: !!this.config.apiKey,
      triggerType: this.config.triggerType,
    });
  }

  onBegin(): void {
    this.startTime = Date.now();
    this.tests = [];
    console.log('[Quent Reporter] Starting test run...');
  }

  onTestEnd(test: any, result: any): void {
    const testFile = test.location?.file || '';
    const fileName =
      testFile.split('/').pop()?.replace('.spec.ts', '') || test.title;

    const quentAnnotation = test.annotations?.find(
      (a: any) => a.type === 'quent-test-id'
    );
    const quentTestId = quentAnnotation?.description;

    const titleParts = test.titlePath();
    const fullTestName = titleParts.join(' > ');
    const extractedTestName = titleParts[titleParts.length - 1] || test.title;
    let extractedFeatureName = '';
    if (titleParts.length >= 2) {
      for (let i = titleParts.length - 2; i >= 0; i--) {
        const part = titleParts[i];
        if (
          part &&
          !part.includes('.spec.ts') &&
          !part.includes('/') &&
          part.trim()
        ) {
          extractedFeatureName = part;
          break;
        }
      }
    }

    const testResult: any = {
      testId: quentTestId || fileName,
      testName: fullTestName,
      testPath: test.location?.file,
      status: result.status,
      duration: result.duration,
      retryCount: result.retry || 0,
      steps: [],
      featureName: extractedFeatureName,
      extractedTestName,
    };

    if (result.error) {
      testResult.error = {
        message: result.error.message || 'Unknown error',
        stack: result.error.stack || '',
      };
    }

    let stepIndex = 0;
    let failureScreenshot: string | null = null;

    const isAutoScreenshot = (name: string | undefined): boolean => {
      if (!name) return false;
      return name === 'screenshot' || name.startsWith('screenshot-');
    };

    for (const attachment of result.attachments || []) {
      if (isAutoScreenshot(attachment.name)) {
        if (result.status !== 'passed' && attachment.contentType?.includes('image')) {
          try {
            if (attachment.path && fs.existsSync(attachment.path)) {
              failureScreenshot = fs
                .readFileSync(attachment.path)
                .toString('base64');
            } else if (attachment.body) {
              if (Buffer.isBuffer(attachment.body)) {
                failureScreenshot = attachment.body.toString('base64');
              } else if (attachment.body instanceof Uint8Array) {
                failureScreenshot = Buffer.from(attachment.body).toString(
                  'base64'
                );
              }
            }
          } catch (e) {
            console.error(`[Quent Reporter] failure screenshot:`, e);
          }
        }
        continue;
      }

      if (attachment.contentType?.includes('image')) {
        let screenshot = '';
        try {
          if (attachment.path && fs.existsSync(attachment.path)) {
            screenshot = fs.readFileSync(attachment.path).toString('base64');
          } else if (attachment.body) {
            if (Buffer.isBuffer(attachment.body)) {
              screenshot = attachment.body.toString('base64');
            } else if (attachment.body instanceof Uint8Array) {
              screenshot = Buffer.from(attachment.body).toString('base64');
            } else if (typeof attachment.body === 'string') {
              screenshot = attachment.body;
            } else {
              screenshot = Buffer.from(attachment.body as any).toString(
                'base64'
              );
            }
          }
        } catch (error) {
          console.error(
            `[Quent Reporter] Error reading screenshot for ${attachment.name}:`,
            error
          );
        }

        if (screenshot && screenshot.length > 0) {
          const name = attachment.name || `Step ${stepIndex + 1}`;
          const isBaseline = name.startsWith('BASELINE:');
          const isFailed = name.startsWith('❌ FAILED:');
          let stepName = name;
          if (isBaseline) stepName = name.replace('BASELINE: ', '');
          if (isFailed) stepName = name.replace('❌ FAILED: ', '');

          const isAssertion =
            name.toLowerCase().includes('assert') ||
            name.toLowerCase().includes('validat') ||
            isBaseline;

          testResult.steps.push({
            stepIndex,
            stepName: isFailed ? `❌ ${stepName}` : stepName,
            stepType: isAssertion ? 'ASSERTION' : 'ACTION',
            screenshot,
            isBaseline,
            assertionPassed: !isFailed,
          });
          stepIndex++;
        }
      }
    }

    if (result.status !== 'passed' && result.error) {
      let failedStepName = 'Unknown Step';
      const titleParts2 = test.titlePath();
      if (titleParts2.length > 2) {
        failedStepName = titleParts2[titleParts2.length - 1];
      }

      const findFailedStep = (steps: any[]): string | null => {
        for (const step of steps || []) {
          if (step.error) {
            return step.title || step.stepName || null;
          }
          if (step.steps && step.steps.length > 0) {
            const found = findFailedStep(step.steps);
            if (found) return found;
          }
        }
        return null;
      };

      const foundStep = findFailedStep(result.steps || []);
      if (foundStep) failedStepName = foundStep;

      const existingFailedStep = testResult.steps.find(
        (s: any) =>
          s.stepName === failedStepName ||
          s.stepName === `❌ ${failedStepName}` ||
          s.stepName.includes(failedStepName)
      );

      const errorMessage = result.error?.message || 'Test failed';
      const errorStack = result.error?.stack || '';

      if (existingFailedStep) {
        existingFailedStep.assertionPassed = false;
        existingFailedStep.error = { message: errorMessage, stack: errorStack };
        if (!existingFailedStep.stepName.startsWith('❌')) {
          existingFailedStep.stepName = `❌ ${existingFailedStep.stepName}`;
        }
        if (failureScreenshot && !existingFailedStep.screenshot) {
          existingFailedStep.screenshot = failureScreenshot;
        }
      } else {
        const failedStep: any = {
          stepIndex,
          stepName: `❌ ${failedStepName}`,
          stepType: 'ACTION',
          assertionPassed: false,
          error: { message: errorMessage, stack: errorStack },
        };
        if (failureScreenshot) failedStep.screenshot = failureScreenshot;
        testResult.steps.push(failedStep);
      }
    }

    if (testResult.steps.length === 0) {
      testResult.steps.push({
        stepIndex: 0,
        stepName: test.title,
        stepType: 'ACTION',
        assertionPassed: result.status === 'passed',
      });
    }

    this.tests.push(testResult);
  }

  async onEnd(): Promise<void> {
    const cfg = this.config;
    if (!cfg.apiKey || !cfg.projectId) {
      console.log('[Quent Reporter] Skipping upload (missing QUENT_API_KEY or QUENT_PROJECT_ID)');
      writeUploadResult({ success: false, error: 'missing credentials' });
      return;
    }

    const debugTests = cfg.debugTests === 'true';
    const testsPayload = this.tests.map(t => {
      const status =
        t.status === 'passed'
          ? 'passed'
          : t.status === 'skipped'
            ? 'skipped'
            : 'failed';

      let steps = t.steps || [];
      if (!debugTests && status === 'passed') {
        steps = steps.map((s: any) => ({
          ...s,
          screenshot: undefined,
        }));
      }

      return {
        testName: t.testName,
        testPath: t.testPath,
        status,
        duration: t.duration,
        error: t.error,
        retryCount: t.retryCount || 0,
        featureName: t.featureName,
        extractedTestName: t.extractedTestName,
        steps: steps.map((s: any, i: number) => ({
          stepIndex: s.stepIndex ?? i,
          stepName: s.stepName,
          stepType: s.stepType || 'ACTION',
          screenshot: s.screenshot,
          assertionPassed: s.assertionPassed,
          isBaseline: s.isBaseline,
          error: s.error,
        })),
      };
    });

    const duration = Date.now() - this.startTime;
    const body = {
      projectId: cfg.projectId,
      branch: cfg.branch,
      platform: cfg.platform,
      prNumber: parseInt(cfg.prNumber, 10) || 0,
      triggerType: cfg.triggerType as 'PR' | 'MANUAL' | 'SCHEDULED' | 'LOCAL',
      repo: cfg.repo || undefined,
      sha: cfg.sha || undefined,
      metadata: {
        githubRunId: cfg.runId,
        durationMs: duration,
        source: 'quent-reporter',
      },
      tests: testsPayload,
    };

    const url = `${cfg.apiUrl.replace(/\/$/, '')}/v1/test-runs`;
    console.log(`[Quent Reporter] POST ${url} (${testsPayload.length} tests)`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      if (!response.ok) {
        console.error(`[Quent Reporter] Upload failed: ${response.status}`, responseText);
        writeUploadResult({ success: false, error: responseText });
        return;
      }

      const data = JSON.parse(responseText) as {
        success?: boolean;
        data?: { id: string; runNumber?: number; deepLink?: string };
      };

      if (data.success && data.data?.id) {
        const diffUrl =
          data.data.deepLink || `https://app.quent.ai/test-run/${data.data.id}`;
        console.log(`[Quent Reporter] OK run #${data.data.runNumber} id=${data.data.id}`);
        writeUploadResult({
          success: true,
          testRunId: data.data.id,
          diffUrl,
        });
      } else {
        writeUploadResult({ success: false, error: 'unexpected response' });
      }
    } catch (error) {
      console.error('[Quent Reporter] Upload error:', error);
      writeUploadResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export default QuentReporter;
