interface RunnerOptions {
    testsDir: string;
    baseUrl: string;
    browser: string;
    retries: number;
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
export declare class TestRunner {
    private options;
    constructor(options: RunnerOptions);
    run(): Promise<RunResults>;
    private createPlaywrightConfig;
    private parseResults;
    private parseSuite;
    private collectScreenshots;
}
export {};
