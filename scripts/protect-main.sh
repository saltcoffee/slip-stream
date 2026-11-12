#!/usr/bin/env bash
# 首次推送后，把 main 分支保护起来：禁止直接推送，只允许通过 Pull Request 合并。
# 用法：
#   ./scripts/protect-main.sh                # 自动识别当前仓库
#   ./scripts/protect-main.sh saltcoffee/slip-stream main
# 依赖：已安装并登录 GitHub CLI（gh auth login），且对仓库有 admin 权限。
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
BRANCH="${2:-main}"

echo "Configuring branch protection for ${REPO}:${BRANCH} (PR-only)…"

gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo "Done. Direct pushes to ${BRANCH} are blocked; all changes must go through a Pull Request."
echo "Tip: add required CI status checks in Settings → Branches (context: check)."
