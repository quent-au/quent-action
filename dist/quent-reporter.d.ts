declare class QuentReporter {
    private config;
    private tests;
    private startTime;
    constructor(_options: Record<string, unknown>);
    onBegin(): void;
    onTestEnd(test: any, result: any): void;
    onEnd(): Promise<void>;
}
export default QuentReporter;
