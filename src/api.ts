import * as core from '@actions/core';
import * as fs from 'fs';

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
  screenshot: string; // base64
  consoleMessages: Array<{ type: string; text: string; timestamp: number }>;
  networkErrors: Array<{ url: string; status: number; statusText: string; method: string }>;
}

interface UploadFailureResponse {
  analysisId: string;
  diffUrl: string;
}

interface DecisionResponse {
  status: 'pending' | 'decided' | 'timeout';
  decision?: 'bug' | 'new_feature';
}

export class QuentiApi {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    return response;
  }

  async downloadTests(params: DownloadTestsParams): Promise<void> {
    core.info(`Downloading tests for project ${params.projectId}, branch ${params.branch}`);

    const response = await this.fetch('/v1/tests/download', {
      method: 'POST',
      body: JSON.stringify({
        projectId: params.projectId,
        branch: params.branch,
        prNumber: params.prNumber,
      }),
    });

    // Handle binary response (zip file)
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(params.outputPath, buffer);
    
    core.info(`Tests downloaded to ${params.outputPath} (${buffer.length} bytes)`);
  }

  async uploadFailure(params: UploadFailureParams): Promise<UploadFailureResponse> {
    core.info(`Uploading failure report for analysis`);

    const response = await this.fetch('/v1/tests/failure-report', {
      method: 'POST',
      body: JSON.stringify({
        projectId: params.projectId,
        prNumber: params.prNumber,
        branch: params.branch,
        repo: params.repo,
        sha: params.sha,
        runId: params.runId,
        report: params.report,
      }),
    });

    return response.json() as Promise<UploadFailureResponse>;
  }

  async waitForDecision(params: { analysisId: string; timeout: number }): Promise<DecisionResponse> {
    const startTime = Date.now();
    const pollInterval = 10000; // 10 seconds

    while (Date.now() - startTime < params.timeout * 1000) {
      try {
        const response = await this.fetch(`/v1/analysis/${params.analysisId}/status`, {
          method: 'GET',
        });

        const data = await response.json() as { status: string; decision?: string };

        if (data.status === 'decided') {
          return {
            status: 'decided',
            decision: data.decision as 'bug' | 'new_feature',
          };
        }

        core.info(`Still waiting for decision... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
        await sleep(pollInterval);
      } catch (error) {
        core.warning(`Error polling for decision: ${error}`);
        await sleep(pollInterval);
      }
    }

    return { status: 'timeout' };
  }

  async notifyMerge(params: {
    projectId: string;
    branch: string;
    targetBranch: string;
  }): Promise<void> {
    await this.fetch('/v1/tests/merge', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


