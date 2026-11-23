# Vendored dependencies

## `xlsx-0.20.3.tgz` - SheetJS Community Edition

The admin reads and writes spreadsheets with SheetJS (`xlsx`): DataView export and import, a dashboard table's
export, in the browser, loaded on demand. SheetJS stopped publishing to npm after 0.18.5 - a version with known
vulnerabilities when reading a crafted file - and distributes newer ones from its own CDN only.

This is that CDN's tarball, byte for byte, kept in the repository so an install needs neither `cdn.sheetjs.com`
(unreachable from networks that only allow a package registry or its mirror) nor a third party's republication on
npm, and so its content is pinned: `pnpm-lock.yaml` records its `integrity`, which `pnpm install --frozen-lockfile`
checks.

- Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- SHA-512 (hex): `a0b0eade3c3b01c2ea2961f60210a9553665f267fa5f661178ff8d7a1d12254cd5fc1759623b61f78b46e6da22301d4f3eb62dc4e09f6a850292fb6e1fedc024`; the
  lockfile holds the same digest in base64.

To update: download the new version's tarball from `https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz`,
read its changelog, replace the file here (named with its version), point `apps/admin/package.json`'s `xlsx` at it
(`file:vendor/xlsx-<version>.tgz`) and run `pnpm install` - the lockfile's integrity changes with it.
