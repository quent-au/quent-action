import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { QuentiApi } from './api';
import { TestRunner } from './runner';
import { readQuentUploadResult } from './reporter';

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('quent-api-key', { required: true });
    const projectId = core.getInput('project-id', { required: true });
    const baseUrl = core.getInput('base-url', { required: true });
    const startCommand = core.getInput('start-command');
    const waitOnUrl = core.getInput('wait-on-url') || baseUrl;
    const waitOnTimeout = parseInt(core.getInput('wait-on-timeout') || '120', 10);
    const quentApiUrl = core.getInput('quent-api-url') || 'https://quent-service.vercel.app';
    const browser = core.getInput('browser') || 'chromium';
    const debugTests = core.getInput('debug-tests') === 'true';

    const context = github.context;
    const isPullRequest = context.eventName === 'pull_request';

    if (!isPullRequest) {
      core.warning('Quent Action is designed to run on pull_request events. Proceeding anyway...');
    }

    const prNumber = context.payload.pull_request?.number;
    const branch = context.payload.pull_request?.head?.ref || context.ref.replace('refs/heads/', '');
    const sha = context.payload.pull_request?.head?.sha || context.sha;
    const repo = `${context.repo.owner}/${context.repo.repo}`;

    core.info(`🔍 Quent AI Tests starting...`);
    core.info(`📦 Project ID: ${projectId}`);
    core.info(`🌿 Branch: ${branch}`);
    core.info(`🔗 Base URL: ${baseUrl}`);

    const api = new QuentiApi(quentApiUrl, apiKey);

    const workDir = path.join(process.cwd(), '.quent-tests');
    await io.mkdirP(workDir);

    core.startGroup('📥 Downloading tests from Quent');
    const testsZipPath = path.join(workDir, 'tests.zip');

    await api.downloadTests({
      projectId,
      branch,
      prNumber: prNumber || 0,
      outputPath: testsZipPath,
    });

    const testsDir = path.join(workDir, 'tests');
    await io.mkdirP(testsDir);

    const zip = new AdmZip(testsZipPath);
    zip.extractAllTo(testsDir, true);

    const extractedEntries = zip.getEntries().map(e => e.entryName);
    core.info(`Extracted ${extractedEntries.length} files to ${testsDir}`);
    for (const entry of extractedEntries) {
      core.info(`  ${entry}`);
    }
    core.endGroup();

    core.startGroup('🎭 Installing Playwright');
    await exec.exec('npx', ['playwright', 'install', '--with-deps', browser], {
      cwd: testsDir,
    });
    core.endGroup();

    let appProcess: exec.ExecOutput | null = null;
    if (startCommand) {
      core.startGroup('🚀 Starting application');
      core.info(`Running: ${startCommand}`);

      const [cmd, ...args] = startCommand.split(' ');
      exec.exec(cmd, args, {
        cwd: process.cwd(),
        silent: true,
      }).catch(() => {});

      core.info(`⏳ Waiting for ${waitOnUrl} to be ready (timeout: ${waitOnTimeout}s)`);
      await exec.exec('npx', ['wait-on', waitOnUrl, '-t', `${waitOnTimeout * 1000}`], {
        cwd: testsDir,
      });
      core.info('✅ Application is ready');
      core.endGroup();
    }

    core.startGroup('🧪 Running Quent tests');
    const runner = new TestRunner({
      testsDir,
      baseUrl,
      browser,
      retries: 1,
      apiKey,
      apiUrl: quentApiUrl,
      projectId,
      prNumber: prNumber || 0,
      branch,
      repo,
      sha,
      runId: context.runId.toString(),
      debugTests,
    });

    const results = await runner.run();
    core.endGroup();

    core.startGroup('📤 Reporting results to Quent');
    const summary = readQuentUploadResult({ testsDir });

    core.info(`📊 Test run: ${summary.testRunId}`);
    core.info(`🔗 View in Quent: ${summary.testRunUrl}`);
    core.setOutput('report-url', summary.testRunUrl);
    core.setOutput('test-run-id', summary.testRunId);
    core.endGroup();

    if (prNumber) {
      core.startGroup('💬 Posting PR comment');
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        const octokit = github.getOctokit(token);
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: createPRComment(results, summary.testRunUrl),
        });
        core.info('✅ PR comment posted');
      } else {
        core.warning('GITHUB_TOKEN not available, skipping PR comment');
      }
      core.endGroup();
    }

    if (results.status === 'passed') {
      core.info('✅ All tests passed!');
      core.setOutput('status', 'passed');
      core.setOutput('passed-tests', results.passed);
      core.setOutput('failed-tests', 0);
      return;
    }

    core.setOutput('status', 'failed');
    core.setOutput('passed-tests', results.passed);
    core.setOutput('failed-tests', results.failed);
    core.setFailed(
      `❌ ${results.failed} test(s) failed. Review details in Quent: ${summary.testRunUrl}`
    );
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('Action failed with unknown error');
    }
  }
}

function createPRComment(
  results: {
    failed: number;
    passed: number;
    failures: Array<{ testName: string; error: string }>;
  },
  testRunUrl: string
): string {
  const failureList = results.failures
    .slice(0, 5)
    .map((f) => `- **${f.testName}**: ${f.error.substring(0, 100)}...`)
    .join('\n');

  const moreFailures =
    results.failures.length > 5
      ? `\n\n*...and ${results.failures.length - 5} more failures*`
      : '';

  return `## 🔍 Quent AI Test Results

### Summary
- ✅ Passed: **${results.passed}**
- ❌ Failed: **${results.failed}**

### Open in Quent
**[View full test run →](${testRunUrl})**

### Failed Tests
${failureList}${moreFailures}

---
*Powered by [Quent AI](https://quent.ai) - AI-Powered Visual Testing*`;
}

run();
