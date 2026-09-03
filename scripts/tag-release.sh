#!/usr/bin/env bash
#
# Tag a release. The release notes are the tag's message — this repo keeps no
# CHANGELOG.md — so the tag has to be annotated and its message has to survive
# intact.
#
#   scripts/tag-release.sh notes.md
#
# The version comes from package.json, because that is the one that reaches the
# built manifest and the store listing; passing it separately would only create
# something for the two to disagree about.
#
# Two things this exists to prevent:
#
#   - `git tag -a -F` runs the message through --cleanup=strip by default,
#     which deletes every line starting with '#'. That is every markdown
#     heading in the notes, removed silently, discovered when the release is
#     already published.
#   - a lightweight tag carries no message at all, so the release build has
#     nothing to publish and fails after doing all the work.

set -euo pipefail

cd "$(dirname "$0")/.."

notes=${1:-}
if [ -z "$notes" ] || [ ! -s "$notes" ]; then
  echo "usage: scripts/tag-release.sh <notes.md>   (a non-empty markdown file)" >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
tag="v$version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "error: $tag already exists. Bump the version in package.json first." >&2
  exit 1
fi

# Tracked changes only. The tag names a commit, and an untracked file is not
# in it — including the notes file itself, which is usually sitting right here
# in the repo when this runs.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "error: tracked files are modified. The tag must name a committed state." >&2
  exit 1
fi

# --cleanup=verbatim is the whole point: it keeps the '#' lines.
git tag -a --cleanup=verbatim -F "$notes" "$tag"

echo "Tagged $tag. Release notes as they will be published:"
echo
git tag -l --format='%(contents)' "$tag" | sed 's/^/  | /'
echo
echo "Push it with:  git push origin $tag"
