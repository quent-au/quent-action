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
export declare class FailureReporter {
    private api;
    constructor(api: QuentiApi);
    createReport(params: CreateReportParams): Promise<ReportResult>;
    private collectTraceFiles;
}
export {};
