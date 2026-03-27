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
    consoleMessages: Array<{
        type: string;
        text: string;
        timestamp: number;
    }>;
    networkErrors: Array<{
        url: string;
        status: number;
        statusText: string;
        method: string;
    }>;
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
export declare class FailureReporter {
    private api;
    constructor(api: QuentiApi);
    /**
     * Test run data is uploaded by `quent-reporter.ts` during Playwright (same as example-sample-ecommerce-tests).
     * This step only reads `quent-upload-result.json` and optionally creates failure analysis.
     */
    createReport(params: CreateReportParams): Promise<ReportResult>;
    private finishAfterReporterUpload;
    private prepareTestMetadata;
}
export {};
