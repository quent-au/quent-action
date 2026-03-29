interface ReadReportParams {
    testsDir: string;
}
export interface QuentUploadSummary {
    testRunId: string;
    testRunUrl: string;
}
/**
 * Reads `quent-upload-result.json` written by `quent-reporter.ts` during Playwright.
 * Test run payload (including screenshots) is uploaded by the reporter only — triage in Quent App.
 */
export declare function readQuentUploadResult(params: ReadReportParams): QuentUploadSummary;
export {};
