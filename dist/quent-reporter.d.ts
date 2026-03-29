declare class QuentReporter {
    private config;
    /** Last attempt wins per Playwright test id (retries overwrite earlier attempts). */
    private testsByKey;
    /** First-seen order of test keys for stable output ordering. */
    private testOrder;
    private startTime;
    constructor(_options: Record<string, unknown>);
    onBegin(): void;
    onTestEnd(test: any, result: any): void;
    onEnd(): Promise<void>;
}
export default QuentReporter;
