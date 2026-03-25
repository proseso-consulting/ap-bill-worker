# Claude Code Configuration

## GitHub CLI

`gh` CLI is authenticated and works for all GitHub operations (PRs, merges, checks).

```bash
# Create PR
gh pr create --title "..." --base master --body "..."

# Merge PR (squash)
gh pr merge <number> --squash --delete-branch

# List PRs
gh pr list --repo proseso-sys-admin/ap-bill-worker
```

## Notes

- Always push to a `claude/<name>-<session-id>` branch; direct pushes to `master` return 403.

---

## Deploying

Push to `master` triggers Cloud Build automatically → Docker build → deploy to Cloud Run.

### Deploy flow
1. Push to feature branch (direct push to `master` returns 403)
2. Open PR → `ap-bill-worker-pr-check` runs (npm ci + syntax check)
3. PR check must pass before merge (branch protection)
4. Merge to `master` → `ap-bill-ocr-worker-deploy` trigger fires → Cloud Run updated

Cloud Run service: `ap-bill-ocr-worker` in `asia-southeast1`, project `odoo-ocr-487104`.

---

## PR Checks

`cloudbuild-pr.yaml` validates code on every pull request:
- `npm ci` — install dependencies
- Syntax check on entry point

Merges to `master` are blocked until PR checks pass (branch protection enabled).

