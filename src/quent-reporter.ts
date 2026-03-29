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
    debugTests: process.env.QUENT_DEBUG_TESTS === 'true' ? 'true' : 'false',
  };
}

/** Keep initial POST small; screenshots follow via PUT (same pattern as addTest + POST .../screenshots). */
function truncateErrorStacksInBody(body: Record<string, unknown>): void {
  const tests = (body.tests as Record<string, unknown>[]) || [];
  for (const t of tests) {
    const err = t.error as { stack?: string } | undefined;
    if (err?.stack && typeof err.stack === 'string' && err.stack.length > 12_000) {
      err.stack = `${err.stack.slice(0, 12_000)}\n…(truncated)`;
    }
    const steps = t.steps as Array<{ error?: { message?: string; stack?: string } }> | undefined;
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      const es = s.error?.stack;
      if (typeof es === 'string' && es.length > 8_000) {
        s.error = {
          message: s.error?.message || '',
          stack: `${es.slice(0, 8_000)}\n…(truncated)`,
        };
      }
    }
  }
}

type StepPayload = {
  stepIndex: number;
  stepName: string;
  stepType: string;
  screenshot?: string;
  assertionPassed?: boolean;
  isBaseline?: boolean;
  error?: { message: string; stack: string };
};

type TestPayload = {
  testName: string;
  testPath?: string;
  status: string;
  duration: number;
  error?: { message: string; stack: string };
  retryCount: number;
  featureName?: string;
  extractedTestName?: string;
  steps: StepPayload[];
};

function stripStepScreenshots(tests: TestPayload[]): TestPayload[] {
  return tests.map(t => ({
    ...t,
    steps: t.steps.map(s => {
      const { screenshot: _omit, ...rest } = s;
      return rest;
    }),
  }));
}

async function uploadStepScreenshotsChunked(
  apiUrl: string,
  apiKey: string,
  runId: string,
  items: { stepId: string; screenshot: string }[]
): Promise<{ ok: number; failed: number }> {
  const base = apiUrl.replace(/\/$/, '');
  let ok = 0;
  let failed = 0;
  const total = items.length;
  for (let i = 0; i < items.length; i++) {
    const { stepId, screenshot } = items[i];
    if (!screenshot) continue;
    const putUrl = `${base}/v1/test-runs/${runId}/steps/${stepId}/screenshot`;
    try {
      const res = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ screenshot }),
      });
      if (!res.ok) {
        const txt = await res.text();
        console.error(
          `[Quent Reporter] Screenshot PUT ${i + 1}/${total} failed (${res.status}): ${txt.slice(0, 200)}`
        );
        failed++;
      } else {
        ok++;
        if (ok % 8 === 0 || i === items.length - 1) {
          console.log(`[Quent Reporter] Screenshots uploaded: ${ok}/${total}`);
        }
      }
    } catch (e) {
      console.error(`[Quent Reporter] Screenshot PUT ${stepId} error:`, e);
      failed++;
    }
  }
  return { ok, failed };
}

function collectScreenshotUploads(
  originalTests: TestPayload[],
  testResults: Array<{ steps?: Array<{ id: string; stepIndex: number }> } | undefined>
): { stepId: string; screenshot: string }[] {
  const out: { stepId: string; screenshot: string }[] = [];
  for (let ti = 0; ti < originalTests.length; ti++) {
    const orig = originalTests[ti];
    const resp = testResults[ti];
    if (!orig?.steps || !resp?.steps?.length) continue;
    for (const step of orig.steps) {
      const sc = step.screenshot;
      if (!sc) continue;
      const respStep = resp.steps.find(s => s.stepIndex === step.stepIndex);
      if (respStep?.id) {
        out.push({ stepId: respStep.id, screenshot: sc });
      } else {
        console.warn(
          `[Quent Reporter] No step id for test "${orig.testName}" stepIndex=${step.stepIndex}; skipping screenshot upload`
        );
      }
    }
  }
  return out;
}

/**
 * Playwright calls `onTestEnd` once per attempt when retries are enabled.
 * The same TestCase has a stable `id` across attempts — we keep only the last result.
 */
function stableTestKey(test: any): string {
  if (test?.id) return String(test.id);
  const loc = test?.location;
  const title =
    typeof test.titlePath === 'function'
      ? test.titlePath().join(' > ')
      : String(test.title ?? '');
  return `${loc?.file ?? ''}:${loc?.line ?? 0}:${title}`;
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
  /** Last attempt wins per Playwright test id (retries overwrite earlier attempts). */
  private testsByKey = new Map<string, any>();
  /** First-seen order of test keys for stable output ordering. */
  private testOrder: string[] = [];
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
    this.testsByKey.clear();
    this.testOrder = [];
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

    const key = stableTestKey(test);
    if (!this.testsByKey.has(key)) {
      this.testOrder.push(key);
    }
    this.testsByKey.set(key, testResult);
  }

  async onEnd(): Promise<void> {
    const cfg = this.config;
    if (!cfg.apiKey || !cfg.projectId) {
      console.log('[Quent Reporter] Skipping upload (missing QUENT_API_KEY or QUENT_PROJECT_ID)');
      writeUploadResult({ success: false, error: 'missing credentials' });
      return;
    }

    const debugTests = cfg.debugTests === 'true';
    const testsList = this.testOrder
      .map(k => this.testsByKey.get(k))
      .filter((t): t is NonNullable<typeof t> => t != null);
    const testsPayloadFull: TestPayload[] = testsList.map(t => {
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
    const body: Record<string, unknown> = {
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
      tests: stripStepScreenshots(testsPayloadFull),
    };
    truncateErrorStacksInBody(body);

    const url = `${cfg.apiUrl.replace(/\/$/, '')}/v1/test-runs`;
    console.log(
      `[Quent Reporter] POST ${url} (${testsPayloadFull.length} tests, metadata-only; screenshots uploaded in chunks)`
    );

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
        data?: {
          id: string;
          runNumber?: number;
          deepLink?: string;
          testResults?: Array<{ steps?: Array<{ id: string; stepIndex: number }> }>;
        };
      };

      if (data.success && data.data?.id) {
        const runId = data.data.id;
        const diffUrl =
          data.data.deepLink || `https://app.quent.ai/test-run/${runId}`;
        console.log(`[Quent Reporter] OK run #${data.data.runNumber} id=${runId}`);

        const toUpload = collectScreenshotUploads(
          testsPayloadFull,
          data.data.testResults || []
        );
        if (toUpload.length > 0) {
          console.log(`[Quent Reporter] Uploading ${toUpload.length} screenshot(s) via PUT (chunked)`);
          const { ok, failed } = await uploadStepScreenshotsChunked(
            cfg.apiUrl,
            cfg.apiKey,
            runId,
            toUpload
          );
          if (failed > 0) {
            console.warn(`[Quent Reporter] ${failed} screenshot upload(s) failed; run metadata still saved`);
          } else {
            console.log(`[Quent Reporter] All ${ok} screenshot(s) uploaded`);
          }
        }

        writeUploadResult({
          success: true,
          testRunId: runId,
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
