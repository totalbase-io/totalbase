# TotalBase brand assets

The mark is a database cylinder with a T cut out of it. Source of truth: `svg/mark.svg`
(the same path the admin's `TotalBaseMark.vue` draws). Primary color: Tailwind `sky-600`,
`#0084d1`. Wordmark set in Inter SemiBold, converted to outlines (no font needed).

| Folder | Use |
|---|---|
| `svg/mark*.svg` | The mark alone: sky, white (over dark or sky), black (`#0f172a`), `currentColor` (inline in a page, takes the text color) |
| `svg/wordmark*.svg` | Mark + "TotalBase", dark text or white text |
| `svg/app-icon.svg` | Rounded sky tile with the white mark (web, social avatars) |
| `svg/app-icon-square.svg` | Square tile, the mark inside the 60 % safe area: iOS and Android/PWA *maskable* icons (the OS rounds it) |
| `png/mark/` | The mark at 16-1024 px, plus white 64-512 px |
| `png/app-icon/` | `apple-touch-icon-180`, `maskable-192/512` (PWA manifest, `"purpose": "maskable"`), `icon-rounded-192/512/1024`, `ios-1024` (App Store) |
| `png/wordmark/` | The wordmark at 1x, 2x and 4x (196 px wide at 1x), dark and white |
| `svg/login-illustration*.svg`, `png/illustration/` | The sign-in page's illustration (the mark at the center; a REST endpoint, a Dashboard, a DataView, a Workflow around it) in a light and a dark version, text as outlines, 520×260 at 1x, PNG at 1x, 2x, 4x (the dark PNG on `#0f172a`) |
| `favicon.ico` | 16, 32 and 48 px (the same file as `apps/admin/public/favicon.ico`) |

Regenerate the PNGs from the SVGs with `rsvg-convert` (`-w N -h N`, or `-z 2` for a 2x wordmark).
