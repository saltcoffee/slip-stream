# Contributing

## Local checks

```bash
npm ci
npm run check   # typecheck + test + build + release checks
```

## Branch protection (PR-only)

After the first push to `main`, run once (requires [GitHub CLI](https://cli.github.com/) and admin rights):

```bash
./scripts/protect-main.sh
```

This blocks direct pushes to `main` and requires changes to go through a Pull Request. Optionally add a required status check (`check`) in **Settings → Branches**.

> Note: branch protection on **private** repositories requires a paid GitHub plan; public repositories are free.

## Release process

Releases are **tag-driven**. Do not bump versions in a feature PR.

1. Open a PR that updates `manifest.json`, `package.json` and `versions.json` to the new `x.y.z` version.
2. Merge the PR into `main` (PR-only, protected branch).
3. Create and push the tag on the merged commit:

   ```bash
   git checkout main && git pull
   git tag 0.1.0
   git push origin 0.1.0
   ```

4. The **Release plugin** workflow runs `npm ci` → `npm run check` → validates the tag equals `manifest.version`, then creates a GitHub Release attaching `main.js`, `manifest.json`, `styles.css`.

### Tag rules

- Tag must be bare `x.y.z` (no `v` prefix).
- `manifest.version` must equal the pushed tag, otherwise the release job fails.
- `versions.json` must map the current version to `minAppVersion`.

## First push (one time)

```bash
git init
git add .
git commit -m "chore: initial SlipStream 0.1.0"
git branch -M main
git remote add origin https://github.com/saltcoffee/slip-stream.git
git push -u origin main
./scripts/protect-main.sh
```
