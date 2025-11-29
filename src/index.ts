import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import * as path from 'path';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import { QuentiApi } from './api';
import { TestRunner } from './runner';
import { FailureReporter } from './reporter';

async function run(): Promise<void> {
  try {
    // Get inputs
    const apiKey = core.getInput('quent-api-key', { required: true });
    const projectId = core.getInput('project-id', { required: true });
    const baseUrl = core.getInput('base-url', { required: true });
    const startCommand = core.getInput('start-command');
    const waitOnUrl = core.getInput('wait-on-url') || baseUrl;
    const waitOnTimeout = parseInt(core.getInput('wait-on-timeout') || '120', 10);
    const quentApiUrl = core.getInput('quent-api-url') || 'https://api.quent.ai';
    const decisionTimeout = parseInt(core.getInput('decision-timeout') || '3600', 10);
    const browser = core.getInput('browser') || 'chromium';

    // Get GitHub context
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

    // Initialize API client
    const api = new QuentiApi(quentApiUrl, apiKey);

    // Create working directory
    const workDir = path.join(process.cwd(), '.quent-tests');
    await io.mkdirP(workDir);

    // Step 1: Download tests from Quent
    core.startGroup('📥 Downloading tests from Quent');
    const testsZipPath = path.join(workDir, 'tests.zip');
    
    await api.downloadTests({
      projectId,
      branch,
      prNumber: prNumber || 0,
      outputPath: testsZipPath,
    });

    // Extract tests
    const testsDir = path.join(workDir, 'tests');
    await io.mkdirP(testsDir);
    
    const zip = new AdmZip(testsZipPath);
    zip.extractAllTo(testsDir, true);
    core.info(`✅ Tests extracted to ${testsDir}`);
    core.endGroup();

    // Step 2: Install Playwright
    core.startGroup('🎭 Installing Playwright');
    await exec.exec('npx', ['playwright', 'install', '--with-deps', browser], {
      cwd: testsDir,
    });
    core.endGroup();

    // Step 3: Start application (if start command provided)
    let appProcess: exec.ExecOutput | null = null;
    if (startCommand) {
      core.startGroup('🚀 Starting application');
      core.info(`Running: ${startCommand}`);
      
      // Start in background
      const [cmd, ...args] = startCommand.split(' ');
      exec.exec(cmd, args, {
        cwd: process.cwd(),
        silent: true,
      }).catch(() => {
        // App might exit when tests complete
      });

      // Wait for app to be ready
      core.info(`⏳ Waiting for ${waitOnUrl} to be ready (timeout: ${waitOnTimeout}s)`);
      await exec.exec('npx', ['wait-on', waitOnUrl, '-t', `${waitOnTimeout * 1000}`], {
        cwd: testsDir,
      });
      core.info('✅ Application is ready');
      core.endGroup();
    }

    // Step 4: Run tests
    core.startGroup('🧪 Running Quent tests');
    const runner = new TestRunner({
      testsDir,
      baseUrl,
      browser,
      retries: 1,
    });

    const results = await runner.run();
    core.endGroup();

    // Step 5: Handle results
    if (results.status === 'passed') {
      core.info('✅ All tests passed!');
      core.setOutput('status', 'passed');
      core.setOutput('passed-tests', results.passed);
      core.setOutput('failed-tests', 0);
      return;
    }

    // Tests failed - report to Quent
    core.startGroup('📤 Reporting failures to Quent');
    const reporter = new FailureReporter(api);
    
    const report = await reporter.createReport({
      projectId,
      prNumber: prNumber || 0,
      branch,
      repo,
      sha,
      runId: context.runId.toString(),
      results,
      testsDir,
    });

    core.info(`📊 Failure report created: ${report.analysisId}`);
    core.info(`🔗 View diff: ${report.diffUrl}`);
    core.setOutput('report-url', report.diffUrl);
    core.endGroup();

    // Step 6: Post PR comment (if PR)
    if (prNumber) {
      core.startGroup('💬 Posting PR comment');
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        const octokit = github.getOctokit(token);
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: createPRComment(results, report.diffUrl, report.analysisId),
        });
        core.info('✅ PR comment posted');
      } else {
        core.warning('GITHUB_TOKEN not available, skipping PR comment');
      }
      core.endGroup();
    }

    // Step 7: Wait for user decision
    core.startGroup('⏳ Waiting for user decision');
    core.info(`Waiting up to ${decisionTimeout} seconds for decision...`);
    
    const decision = await api.waitForDecision({
      analysisId: report.analysisId,
      timeout: decisionTimeout,
    });

    if (decision.status === 'timeout') {
      core.setFailed('⏰ Timeout waiting for user decision');
      return;
    }

    if (decision.decision === 'bug') {
      core.setFailed('🐛 Test failures confirmed as bugs');
      core.setOutput('status', 'failed');
      return;
    }

    if (decision.decision === 'new_feature') {
      core.info('✨ Failures marked as new feature - baselines updated');
      core.info('🔄 Tests will be re-run automatically...');
      
      // The backend should trigger a re-run, but we can also do it here
      core.setOutput('status', 'pending_rerun');
      
      // Re-download updated tests and run again
      await api.downloadTests({
        projectId,
        branch,
        prNumber: prNumber || 0,
        outputPath: testsZipPath,
      });

      const newZip = new AdmZip(testsZipPath);
      newZip.extractAllTo(testsDir, true);

      const rerunResults = await runner.run();
      
      if (rerunResults.status === 'passed') {
        core.info('✅ Re-run passed with updated baselines!');
        core.setOutput('status', 'passed');
        return;
      } else {
        core.setFailed('❌ Re-run failed even after baseline update');
        core.setOutput('status', 'failed');
        return;
      }
    }

    core.endGroup();
    core.setOutput('status', 'passed');
    core.setOutput('passed-tests', results.passed);
    core.setOutput('failed-tests', results.failed);

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('Action failed with unknown error');
    }
  }
}

function createPRComment(
  results: { failed: number; passed: number; failures: Array<{ testName: string; error: string }> },
  diffUrl: string,
  analysisId: string
): string {
  const failureList = results.failures
    .slice(0, 5) // Show max 5 failures in comment
    .map((f) => `- **${f.testName}**: ${f.error.substring(0, 100)}...`)
    .join('\n');

  const moreFailures = results.failures.length > 5 
    ? `\n\n*...and ${results.failures.length - 5} more failures*` 
    : '';

  return `## 🔍 Quent AI Test Results

### Summary
- ✅ Passed: **${results.passed}**
- ❌ Failed: **${results.failed}**

### Failed Tests
${failureList}${moreFailures}

---

### 📸 [View Screenshots & Diff](${diffUrl})

**What would you like to do?**

| Action | Link |
|--------|------|
| ✅ Mark as New Feature | [Update baselines & re-run](https://app.quent.ai/analysis/${analysisId}?action=accept) |
| ❌ Confirm as Bug | [Fail this check](https://app.quent.ai/analysis/${analysisId}?action=reject) |

---
*Powered by [Quent AI](https://quent.ai) - AI-Powered QA Testing*`;
}

run();

