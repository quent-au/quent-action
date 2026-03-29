interface DownloadTestsParams {
    projectId: string;
    branch: string;
    prNumber: number;
    outputPath: string;
}
export declare class QuentiApi {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    private fetch;
    downloadTests(params: DownloadTestsParams): Promise<void>;
    notifyMerge(params: {
        projectId: string;
        branch: string;
        targetBranch: string;
    }): Promise<void>;
}
export {};
