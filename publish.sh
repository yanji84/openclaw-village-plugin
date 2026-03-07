#!/usr/bin/env bash
set -euo pipefail

# Usage: ./publish.sh [patch|minor|major]
# Bumps version, publishes to npm, and commits.

BUMP="${1:-patch}"
cd "$(dirname "$0")"

# Bump version in package.json (no git tag — we commit manually)
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
echo "Bumped to $NEW_VERSION"

# Publish
npm publish
echo "Published $NEW_VERSION to npm"

# Stage and remind
echo ""
echo "Done! Don't forget to commit:"
echo "  git add templates/plugins/village/package.json"
echo "  git commit -m \"chore(village-plugin): publish $NEW_VERSION\""
