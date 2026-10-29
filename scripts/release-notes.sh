#!/usr/bin/env bash
# Prints a version's GitHub release notes: its section of CHANGELOG.md between the install instructions and the
# compatibility note every release carries. The Release workflow publishes them (.github/workflows/release.yml);
# run it by hand to read them first, or to fill a release the workflow didn't create.
#
#   scripts/release-notes.sh 0.1.0-beta.9
set -euo pipefail

VERSION="${1:?usage: release-notes.sh <version>}"
cd "$(dirname "$0")/.."

# The lines under "## <version> - <date>" up to the next version's heading; its "###" become the release's "##".
SECTION="$(awk -v heading="## $VERSION " '
  index($0, heading) == 1 { found = 1; next }
  found && /^## / { exit }
  found { sub(/^### /, "## "); print }
' CHANGELOG.md | sed -e '/./,$!d')"
[ -n "$SECTION" ] || { echo "CHANGELOG.md has no section for $VERSION." >&2; exit 1; }

INTRO="TotalBase $VERSION. It upgrades a database from any earlier beta in place: pull the new image and restart."
grep -q '^## Before you upgrade' <<<"$SECTION" && INTRO="$INTRO Read **Before you upgrade** first."

cat <<NOTES
$INTRO

## Install

\`\`\`bash
docker run -d --name totalbase -p 3030:3030 -v totalbase-data:/var/lib/totalbase \\
  -e POSTGRES_HOST=your-server -e POSTGRES_DB=acme -e POSTGRES_USER=totalbase -e POSTGRES_PASSWORD=... \\
  totalbase/totalbase:$VERSION
docker logs totalbase   # the link that creates the first administrator
\`\`\`

Images: \`totalbase/totalbase:$VERSION\` on Docker Hub, for amd64 and arm64. Full guide: [Installation](https://docs.totalbase.io/getting-started/installation).

$SECTION

## Compatibility

PostgreSQL 15, 16, 17 and 18, with a role that is not a superuser. APIs may still change before 1.0. Every version's changes: [CHANGELOG.md](https://github.com/totalbase-io/totalbase/blob/main/CHANGELOG.md).

Documentation: https://docs.totalbase.io · Security reports: security@totalbase.io
NOTES
