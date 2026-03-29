import * as core from '@actions/core';
import * as fs from 'fs';

interface DownloadTestsParams {
  projectId: string;
  branch: string;
  prNumber: number;
  outputPath: string;
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
      Authorization: `Bearer ${this.apiKey}`,
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

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(params.outputPath, buffer);

    core.info(`Tests downloaded to ${params.outputPath} (${buffer.length} bytes)`);
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
