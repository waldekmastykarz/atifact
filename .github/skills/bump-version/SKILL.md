---
name: bump-version
description: This skill should be used when the user asks to "bump the version", "release a new version", "prepare a release", "update the version number", "version bump", or needs to determine and apply a semver version increment based on recent commits.
---

# Bump Version

Analyze commits since the last release tag and determine the appropriate semver version bump, then apply it using `npm version`.

## Workflow

Follow these steps in order. Do not skip the confirmation step.

### Step 1: Identify the Latest Tag

Run `git tag --sort=-v:refname | head -1` to find the most recent version tag. Tags follow the `v*` pattern (e.g., `v1.0.3`).

### Step 2: List Commits Since the Last Tag

Run `git log <latest-tag>..HEAD --oneline` to retrieve all unreleased commits. If there are no commits since the last tag, inform the user and stop.

### Step 3: Determine the Version Bump Type

Analyze each commit message to classify the version bump:

- **major** — Any commit indicates a breaking change. Look for:
  - `BREAKING CHANGE` or `BREAKING:` in the message
  - `!` after the type (e.g., `feat!:`, `fix!:`)
- **minor** — Any commit adds new functionality. Look for:
  - `feat:` or `feat(scope):` prefix
  - Commits describing new commands, options, or capabilities
- **patch** — All other changes. Common indicators:
  - `fix:`, `deps:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`, `ci:` prefixes
  - Dependency bumps, bug fixes, maintenance tasks

Apply the highest applicable level: if any commit is major, bump major. If any commit is minor (and none are major), bump minor. Otherwise, bump patch.

### Step 4: Confirm with the User

**STOP — Do not proceed without user confirmation.**

Present the analysis to the user:
1. List the commits since the last tag
2. State the recommended bump type and the reasoning
3. Show what the new version number will be (current → new)
4. Ask the user to confirm or choose a different bump type

### Step 5: Update the Changelog

**STOP — Read CHANGELOG.md before writing.** Match the existing format and style.

Add a new entry at the top of CHANGELOG.md (below the `# Changelog` heading) for the new version:

1. Use today's date and the new version number
2. Add a compare link to the previous tag: `[X.Y.Z](https://github.com/waldekmastykarz/atifact/compare/vPREV...vX.Y.Z)`
3. Group changes into sections: **Features**, **Bug Fixes**, **Maintenance** (only include sections that apply)
4. Write human-friendly descriptions, not raw commit messages
5. **Only include user-facing changes** — skip dependency bumps, CI changes, and internal refactors unless they affect users (e.g., minimum Node.js version change is user-facing)
6. Stage the file: `git add CHANGELOG.md`

### Step 6: Apply the Version Bump

Commit the staged changelog, then run `npm version`:

```bash
git commit -m "docs: update changelog for vX.Y.Z"
npm version <patch|minor|major>
```

The `npm version` command requires a clean working directory. Committing the changelog first ensures it runs without issues. `npm version` then updates `package.json`, creates a second commit, and tags it.

### Step 7: Remind About Publishing

After bumping, remind the user to push the commit and tag to trigger the publish workflow:

```bash
git push && git push --tags
```

The GitHub Actions workflow automatically publishes to npm when a `v*` tag is pushed.
