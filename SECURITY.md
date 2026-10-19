# Security and Publishing

This is a local, single-user learning demo. Keep the server bound to loopback;
it is not an authenticated public service. Real invoice submission is disabled.
Reviewing a screenshot only records simulated success, never a real application.

## Private Files

Keep API keys and account-specific endpoints in the local `.env`. Only the empty
`.env.example` is published. Do not publish provider API-key CSV exports, credential
files, databases, QR originals, invoice URLs, screenshots, browser traces, uploads,
model session histories, or diagnostic logs. `data/`, `test-results/` and
`diagnostics/` are local-only directories. A custom data directory must also be
excluded before committing.

The publication check scans the exact Git index, blocks known private paths and
common credential formats, and checks for values from the local `.env`. It prints
only file names, line numbers and reasons, not matched secrets:

```powershell
git add .env.example .gitignore .prettierrc.json AGENTS.md README.md SECURITY.md
git add package.json package-lock.json requirements.txt vite.config.mjs src tests tools docs
npm run check:publish
git diff --cached --stat
git commit -m "Describe the change"
```

This is a focused check, not a guarantee: manually review new attachments and
fixtures, and never use `git add -f` for private files. After staging further edits,
run the check again. Git ignore rules do not remove already tracked files or
erase earlier commits. If a credential is ever published, revoke or rotate it;
removing the current file alone is insufficient.

## Tests

Install the Node and Python dependencies before testing. Public QR and UI tests
use synthetic data. Regression tests requiring `data/samples/` are explicitly
skipped when the private samples are absent; that is not business acceptance.

`test:chat`, `test:harness` and other `*-live.mjs` scripts are opt-in: some call
paid model/browser services or need private local samples. Do not run them
automatically in CI or use them to bypass the real-submission restriction.

## Reporting

Do not include real keys, invoice links, tax IDs, emails, screenshots or model
histories in public issues. Reproduce problems with synthetic data.
