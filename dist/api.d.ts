interface DownloadTestsParams {
    projectId: string;
    branch: string;
    prNumber: number;
    outputPath: string;
}
interface UploadFailureParams {
    projectId: string;
    prNumber: number;
    branch: string;
    repo: string;
    sha: string;
    runId: string;
    report: FailureReport;
}
interface FailureReport {
    status: string;
    duration: number;
    tests: TestResult[];
}
interface TestResult {
    testId: string;
    testName: string;
    status: string;
    duration: number;
    error?: {
        message: string;
        stack: string;
    };
    steps: StepResult[];
    retryCount: number;
}
interface StepResult {
    stepIndex: number;
    stepName: string;
    screenshot: string;
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
interface UploadFailureResponse {
    analysisId: string;
    diffUrl: string;
}
interface DecisionResponse {
    status: 'pending' | 'decided' | 'timeout';
    decision?: 'bug' | 'new_feature';
}
export declare class QuentiApi {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    private fetch;
    downloadTests(params: DownloadTestsParams): Promise<void>;
    uploadFailure(params: UploadFailureParams): Promise<UploadFailureResponse>;
    waitForDecision(params: {
        analysisId: string;
        timeout: number;
    }): Promise<DecisionResponse>;
    notifyMerge(params: {
        projectId: string;
        branch: string;
        targetBranch: string;
    }): Promise<void>;
}
export {};
