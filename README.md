# Quent AI GitHub Action

Run AI-generated Playwright tests on your pull requests with zero configuration. Results upload to Quent; open the **Quent App** to review failures and screenshots.

## Features

- 🚀 **Zero Configuration** - Just add the action to your workflow
- 🔄 **Smart Retries** - Automatic retry on flaky tests
- 📸 **Visual Diff** - See exactly what changed with screenshot comparisons
- 💬 **PR Comments** - Summary with a link to the full test run in Quent
- 🌿 **Branch-aware** - Maintains separate baselines for feature branches

## Quick Start

### 1. Add Secrets to Your Repository

Go to your repository's Settings → Secrets and variables → Actions, and add:

- `QUENT_API_KEY` - Your Quent API key
- `QUENT_PROJECT_ID` - Your Quent project ID

### 2. Create Workflow File

Create `.github/workflows/quent.yml` in your repository:

```yaml
name: Quent AI Tests

on:
  pull_request:
    types: [labeled, synchronize]

jobs:
  quent-test:
    if: contains(github.event.pull_request.labels.*.name, 'quent')
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Dependencies
        run: npm ci

      - name: Run Quent Tests
        uses: quent-ai/quent-action@v1
        with:
          quent-api-key: ${{ secrets.QUENT_API_KEY }}
          project-id: ${{ secrets.QUENT_PROJECT_ID }}
          base-url: 'http://localhost:3000'
          start-command: 'npm run start'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 3. Add the `quent` Label to Your PR

That's it! When you add the `quent` label to a PR, Quent will automatically run your tests.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `quent-api-key` | Your Quent API key | Yes | - |
| `project-id` | Your Quent project ID | Yes | - |
| `base-url` | Base URL of your application | Yes | - |
| `start-command` | Command to start your app (optional) | No | - |
| `wait-on-url` | URL to wait for before testing | No | `base-url` |
| `wait-on-timeout` | Timeout for app startup (seconds) | No | `120` |
| `quent-api-url` | Quent API URL (for self-hosted) | No | `https://quent-service.vercel.app` |
| `browser` | Browser to use (chromium/firefox/webkit) | No | `chromium` |
| `debug-tests` | Upload screenshots for passed tests too (larger payloads) | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `status` | Test run status (`passed` or `failed`) |
| `report-url` | URL to open the test run in Quent |
| `test-run-id` | Quent test run id |
| `passed-tests` | Number of passed tests |
| `failed-tests` | Number of failed tests |

## How It Works

### Test Execution Flow

```
1. PR created/updated (e.g. with 'quent' label)
            ↓
2. Download tests from Quent
            ↓
3. Start your application (optional)
            ↓
4. Run Playwright tests (Quent reporter uploads the run)
            ↓
      ┌─────┴─────┐
      ↓           ↓
   Passed      Failed
      ↓           ↓
   ✅ Done    Retry once, then upload + PR comment + fail job
                  ↓
         Review details in Quent App (link in comment)
```

### PR Comment Example

When tests fail, Quent posts a comment to your PR:

> ## 🔍 Quent AI Test Results
>
> ### Summary
> - ✅ Passed: **12**
> - ❌ Failed: **2**
>
> ### Failed Tests
> - **Login Flow > should show error on invalid credentials**: Expected button to be visible...
> - **Checkout > should calculate total correctly**: Expected $99.99, got $89.99...
>
> Open the Quent app and filter by your branch to see the results.

## Advanced Usage

### Custom Application Setup

If your app needs special setup:

```yaml
- name: Setup Database
  run: npm run db:migrate

- name: Seed Test Data
  run: npm run db:seed

- name: Run Quent Tests
  uses: quent-ai/quent-action@v1
  with:
    quent-api-key: ${{ secrets.QUENT_API_KEY }}
    project-id: ${{ secrets.QUENT_PROJECT_ID }}
    base-url: 'http://localhost:3000'
    start-command: 'npm run start:test'
```

### Running on Every PR (Without Label)

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  quent-test:
    runs-on: ubuntu-latest
    # ... rest of config
```

### Multiple Browsers

```yaml
strategy:
  matrix:
    browser: [chromium, firefox, webkit]

steps:
  - uses: quent-ai/quent-action@v1
    with:
      # ...
      browser: ${{ matrix.browser }}
```

### With Docker Compose

```yaml
- name: Start Services
  run: docker-compose up -d

- name: Wait for Services
  run: |
    npm install -g wait-on
    wait-on http://localhost:3000 http://localhost:5432

- name: Run Quent Tests
  uses: quent-ai/quent-action@v1
  with:
    quent-api-key: ${{ secrets.QUENT_API_KEY }}
    project-id: ${{ secrets.QUENT_PROJECT_ID }}
    base-url: 'http://localhost:3000'
    # No start-command needed, app is already running
```

## Troubleshooting

### Tests timeout waiting for app

Increase the `wait-on-timeout`:

```yaml
with:
  wait-on-timeout: '300'  # 5 minutes
```

### Tests fail with network errors

Make sure your app allows connections from localhost:

```yaml
with:
  base-url: 'http://127.0.0.1:3000'  # Try explicit IP
```

### Action can't post PR comments

Ensure `GITHUB_TOKEN` has write permissions:

```yaml
permissions:
  pull-requests: write

env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Support

<!-- - 📚 [Documentation](https://docs.quent.ai)
- 💬 [Discord Community](https://discord.gg/quent)
- 📧 [Email Support](mailto:support@quent.ai)
- 🐛 [Report Issues](https://github.com/quent-ai/quent-action/issues) -->

## License

MIT © [Quent AI](https://quent.ai)



