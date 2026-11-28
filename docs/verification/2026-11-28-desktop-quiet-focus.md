# Desktop transport: less of the user's screen, checked live (2026-11-28)

macOS 26 (Darwin 25.6), Antigravity 2.36.0, preset `Turbo`, project `agybird`, branch `feat/desktop-quiet-focus` on top of the 2.36 support.

| Check | How | Result |
| --- | --- | --- |
| Background writes into the composer, to skip the paste | `AXSelectedText`, then `AXValue`, then `AXFocused` and `AXSelectedText`, with the app behind | Every set returns success and the composer stays empty: the paste, and the app in front for it, stay. |
| Presence reads | `probe` | `idle` (seconds since the last input), `locked`, `on_screen` read without the app in front. |
| Whole clipboard round trip | every item and type copied to a private pasteboard and read back | identical, a Chromium copy with `public.html` and its source types included; the general pasteboard was not written. |
| Read task, short prompt | `scripts/desktop.mjs`, reply `READY` | `success`, 14 s, front app and clipboard restored, lock gone. |
| Read task, 20.9 KB prompt, every bridge call timed | `scripts/desktop.mjs` through a timing wrapper | `success` `LONG-OK`. The app was in front 3.9 s, from the switch to the restore of the user's app: `front` 0.45 s, `new-conversation` 1.45 s, the snapshot, `paste-input` 0.6 s, `restore` 0.6 s. `read-input` (1.4 s) and Send (1.2 s) ran with the app behind. The run first waited 60 s while the user kept using the Mac. |

## Not checked live

- The 2-minute limit of the idle wait (`blocked: user_active`), a locked screen and an app window on another Space or minimized (`not_on_screen`); the simulated app covers them.
- Putting back an image or a file on the clipboard during a run; the round trip above and the simulated app cover it.
