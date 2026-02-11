# OpenCode Machina Release Governance

## Release Channels

| Channel | Branch | Purpose | Stability |
|---------|--------|---------|-----------|
| **Stable** | `main` | Production-ready releases | Production-grade |
| **Beta** | `beta` | Pre-release testing | Pre-production |

## Branch & Tag Rules

### Branch Model

```
main  ← beta  ← feature/*
```

- **`main`**: Protected branch for stable releases only. Direct commits disabled. Merge via PR.
- **`beta`**: Protected branch for beta releases. Direct commits disabled. Merge via PR.
- **`feature/*`**: Short-lived branches for development. Delete after merge.

### Tag Rules

#### Stable Tags
- Format: `vX.Y.Z` (Semantic Versioning)
- Must reference `main` branch commit
- Example: `v1.0.0`, `v1.2.3`

#### Beta Tags
- Format: `vX.Y.Z-beta.N`
- Must reference `beta` branch commit
- Example: `v1.0.0-beta.1`, `v1.0.0-beta.2`

#### Hotfix Tags
- Format: `vX.Y.Z` (follows stable format)
- Can reference branches created from stable tags
- Example: `v1.0.1` (hotfix on `v1.0.0`)

## Version Source of Truth

**Single source of truth: Git tags on `main` and `beta` branches.**

### Synchronization Rule

```
Git tag version ↔ Package versions (when published)
```

For all packages in `packages/*`:
- If a package has a `version` field, it MUST match the current stable/beta tag minus any suffix
- Example: Tag `v1.2.3` → package versions `1.2.3`
- Example: Tag `v1.2.0-beta.1` → package versions `1.2.0-beta.1` (when pre-releasing)

### Version Update Process

When creating a release tag:
1. Update all package versions in workspace
2. Commit version updates
3. Create git tag
4. Push both commit and tag

Never create a tag without first committing version updates.

## Stable Release Procedure

### Prerequisites
- All Required Pre-Release Gates must pass (see below)
- Branch: `main`
- Status: Clean working directory

### Steps

```bash
# 1. Ensure on main branch
git checkout main
git pull origin main

# 2. Update version numbers (replace X.Y.Z with actual version)
# Update root package.json (if versioned)
# Update packages/*/package.json versions to X.Y.Z
bun run version:patch  # or version:minor/version:major, if implemented
# OR manually edit package.json files

# 3. Commit version bump
git add .
git commit -m "chore: bump version to X.Y.Z"

# 4. Create annotated tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# 5. Push commit and tag
git push origin main
git push origin vX.Y.Z

# 6. Create GitHub Release (non-prerelease)
# gh release create vX.Y.Z --generate-notes
```

### Verification
```bash
# Verify tag points to correct commit
git show vX.Y.Z

# Verify tag annotation exists
git tag -l -n9 vX.Y.Z
```

## Beta Release Procedure

### Prerequisites
- All Required Pre-Release Gates must pass
- Branch: `beta`
- Status: Clean working directory

### Steps

```bash
# 1. Ensure on beta branch
git checkout beta
git pull origin beta

# 2. Update version numbers with beta suffix
# Update packages/*/package.json versions to X.Y.Z-beta.N
bun run version:prerelease beta  # if implemented
# OR manually edit package.json files

# 3. Commit version bump
git add .
git commit -m "chore: bump version to X.Y.Z-beta.N"

# 4. Create annotated tag
git tag -a vX.Y.Z-beta.N -m "Beta vX.Y.Z-beta.N"

# 5. Push commit and tag
git push origin beta
git push origin vX.Y.Z-beta.N

# 6. Create GitHub Release (prerelease=true)
# gh release create vX.Y.Z-beta.N --prerelease --generate-notes
```

### GitHub Releases Pre-release Flag
- **Beta tags must have `--prerelease` flag enabled**
- This marks the release as non-production in GitHub UI
- Prevents automatic notifications/feeds that trigger for stable releases
- Does not affect npm publishing behavior (controlled by version field)

### Verification
```bash
# Verify tag points to correct commit
git show vX.Y.Z-beta.N

# Verify tag annotation exists
git tag -l -n9 vX.Y.Z-beta.N

# Verify via GitHub API (optional)
gh release view vX.Y.Z-beta.N --json prerelease
```

## Promote Beta to Stable

### When to Promote
- Beta has been tested thoroughly
- No critical bugs found
- All feedback addressed

### Steps

```bash
# 1. Merge beta into main
git checkout main
git pull origin main
git merge origin/beta

# 2. Resolve conflicts if any (rare if disciplined)

# 3. Update versions from beta suffix to stable
# Update packages/*/package.json versions from X.Y.Z-beta.N to X.Y.Z
# Remove beta suffix

# 4. Commit version update
git add .
git commit -m "chore: promote vX.Y.Z-beta.N to stable vX.Y.Z"

# 5. Create stable tag
git tag -a vX.Y.Z -m "Release vX.Y.Z (promoted from vX.Y.Z-beta.N)"

# 6. Push commit and tag
git push origin main
git push origin vX.Y.Z

# 7. Create GitHub Release (non-prerelease)
# gh release create vX.Y.Z --notes "Promoted from vX.Y.Z-beta.N"
```

### Important
- **Do not re-tag beta commits as stable** - create a new commit on `main`
- This maintains clear history: `beta` → `main` merge
- Allows rollback if promotion reveals issues

## Hotfix Procedure

### Use Cases
- Critical bug in stable release
- Security vulnerability
- Data corruption issue

### Steps

```bash
# 1. Create hotfix branch from stable tag
git checkout vX.Y.Z
git checkout -b hotfix/vX.Y.Z+1

# 2. Apply fix (minimal changes only)

# 3. Update version (patch increment)
# Update version to X.Y.(Z+1)
# Example: v1.0.0 → v1.0.1

# 4. Commit and test
git add .
git commit -m "fix: [description of hotfix]"
bun test

# 5. Merge hotfix to main
git checkout main
git merge hotfix/vX.Y.Z+1

# 6. Create hotfix tag
git tag -a vX.Y.(Z+1) -m "Hotfix vX.Y.(Z+1)"

# 7. Backport to beta (if beta exists ahead of stable)
git checkout beta
git merge hotfix/vX.Y.Z+1

# 8. Push all
git push origin main
git push origin beta
git push origin vX.Y.(Z+1)

# 9. Delete hotfix branch
git branch -d hotfix/vX.Y.Z+1
```

### After Hotfix
- Document hotfix in release notes
- Consider merging into `beta` if beta branch has diverged
- Tag with patch version only (do not increment major/minor)

## Rollback Procedure

### Rollback Strategy: Create New Release Forward

**Do NOT delete tags or force-push releases.** Always create a new release to roll forward.

### Steps

```bash
# 1. Create rollback branch from previous stable tag
git checkout vPREVIOUS_VERSION
git checkout -b rollback/vNEW_VERSION

# 2. If necessary, cherry-pick critical fixes only
# git cherry-pick <commit-hash>

# 3. Update version (patch increment)
# Example: v1.1.0 (bad) → v1.1.1 (rollback)

# 4. Commit
git add .
git commit -m "chore: rollback vNEW_VERSION to vPREVIOUS_VERSION content"

# 5. Create rollback tag
git tag -a vX.Y.Z+1 -m "Rollback to vPREVIOUS_VERSION behavior"

# 6. Push to main
git checkout main
git merge rollback/vNEW_VERSION
git push origin main
git push origin vX.Y.Z+1

# 7. Create GitHub Release with clear rollback notes
# gh release create vX.Y.Z+1 --notes "Rolls back vNEW_VERSION due to [reason]"
```

### Rollback Documentation
- Always explain WHY in release notes
- Document what was broken
- Reference the problematic release
- Provide timeline for re-release with fixes

### NEVER DO
- Do NOT delete git tags (breaks trust in history)
- Do NOT force-push to existing tags
- Do NOT modify published packages (new version only)
- Do NOT silently revert (communicate transparently)

## Required Pre-Release Gates

Before creating ANY release tag (stable or beta):

### 1. Code Quality
```bash
# All tests pass
bun test

# Type checking passes
bun run typecheck

# Linting passes (if configured)
bun run lint
```

### 2. Build Verification
```bash
# Clean build succeeds
bun run build

# Build artifacts are valid
# (verify dist/* output)
```

### 3. Version Consistency
```bash
# Check all workspace versions are in sync
# (manual verification or tool)

# Check version follows semver rules
# (major.minor.patch[-prerelease.N])
```

### 4. Changelog
- [ ] Release notes prepared
- [ ] Breaking changes documented (if any)
- [ ] Migration guide included (if needed)

### 5. Documentation
- [ ] README updated if API changes
- [ ] CHANGELOG.md updated
- [ ] Breaking changes clearly marked

### 6. Beta-Specific (for beta releases)
- [ ] Tested on staging environment
- [ ] Integration tests pass
- [ ] Performance regression check (if applicable)

## Release Authority

### Who Can Create Releases
- Maintainers with write access to `main` and `beta` branches
- CI/CD automation (when configured)

### Who Can Approve Releases
- At least one maintainer review
- All pre-release gates must pass

### Release Communication
- Notify team before promoting beta to stable
- Announce stable releases via GitHub Releases
- Document breaking changes prominently

---

## Quick Reference

### Tag Patterns
- Stable: `v1.0.0`
- Beta: `v1.0.0-beta.1`
- Hotfix: `v1.0.1`

### Branch Flow
```
feature/* → beta → main
hotfix/* → main (and optionally beta)
```

### Version Increment Commands (when implemented)
- `bun run version:patch` → `1.0.0` → `1.0.1`
- `bun run version:minor` → `1.0.0` → `1.1.0`
- `bun run version:major` → `1.0.0` → `2.0.0`
- `bun run version:prerelease beta` → `1.0.0` → `1.0.0-beta.1`

### Tag Creation
```bash
# Stable
git tag -a v1.0.0 -m "Release v1.0.0"

# Beta
git tag -a v1.0.0-beta.1 -m "Beta v1.0.0-beta.1"
```

### GitHub Release
```bash
# Stable (production)
gh release create v1.0.0 --generate-notes

# Beta (pre-release)
gh release create v1.0.0-beta.1 --prerelease --generate-notes
```
