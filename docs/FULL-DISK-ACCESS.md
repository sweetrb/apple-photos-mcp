# Full Disk Access for Apple Photos

Apple Photos MCP needs **Full Disk Access (FDA)** for the process that runs the
MCP server. Unlike some Apple MCP servers, this is **not optional** — without it,
**no tool works**, because every tool ultimately reads the Photos library's
SQLite database, and that database lives in a macOS-protected directory.

## Why it's needed

This server is backed by [osxphotos](https://github.com/RhetTbull/osxphotos),
which reads the Photos library database **directly** — it does **not** go through
Photos.app. The library and its database live here:

```
~/Pictures/Photos Library.photoslibrary/database/
```

Everything under `~/Pictures/Photos Library.photoslibrary/` is gated by macOS
privacy protection. Reading it requires **Full Disk Access** for the *host*
process — the application that actually launches `node` and spawns the Python
sidecar. Without that grant, macOS denies the read before osxphotos can open the
database, and the server can do nothing.

(The MCP only ever **reads** the library database; it never writes to it. See
[LIMITATIONS.md](./LIMITATIONS.md).)

## How to grant Full Disk Access

1. Open **System Settings** (or **System Preferences** on older macOS).
2. Go to **Privacy & Security → Full Disk Access**.
3. Click the **+** button (you may need to unlock with Touch ID / your password
   first), and add the application that **hosts** the MCP server — i.e. the app
   that actually launches `node`:
   - **Claude Desktop** → `/Applications/Claude.app`
   - **Terminal** (if you run Claude Code from a shell) → `/Applications/Utilities/Terminal.app`
   - **iTerm** → `/Applications/iTerm.app`
   - **VS Code** → `/Applications/Visual Studio Code.app`
4. Make sure the toggle next to the app is **on**.
5. **Fully quit and reopen the host app.** macOS only applies the new permission
   to processes started *after* the change — a reload or restart-server is not
   enough; the host application itself must be quit (⌘Q) and relaunched.

> **Grant FDA to the right app.** FDA applies to the process that spawns the
> server, not to `node`, `python3`, or to Photos.app. If you launch Claude Code
> from iTerm, grant it to iTerm; if you use Claude Desktop, grant it to Claude.
> Granting it to the wrong app has no effect.

## Verifying it worked

The best verification is the **`doctor`** tool. It runs the full setup
diagnostic — osxphotos install, Photos library readability, and **Full Disk
Access** — and reports each as ok / warn / fail. The Full Disk Access check is
explicit: if the grant took effect it reports `ok`; if it's missing it reports
`fail` with a pointer back to this guide.

For a quicker smoke test, run **`health-check`**. It confirms two things in one
shot: that osxphotos is installed, and that the Photos library can actually be
opened. If FDA is granted, it returns OK along with the osxphotos version, the
library path, and the total photo count.

A quick follow-up is **`library-info`**, which reads counts of photos, movies,
albums, folders, keywords, and persons straight out of the library database. If
that returns real numbers, the FDA grant took effect.

## What failure looks like without it

When FDA is missing (or granted to the wrong app), the read is denied at the OS
level and tools fail with a permissions-flavored error. Typical messages:

- `operation not permitted`
- `unable to open database file`
- `Error copying …/Photos Library.photoslibrary/database/Photos.sqlite to /tmp/osxphotos_…/Photos.sqlite`
- a generic "Library not found" / permission error from `health-check`

The `Error copying …/Photos.sqlite to /tmp/…` form is the most misleading: osxphotos
copies the live library database to a temp directory before opening it, and when
the host process lacks FDA, macOS denies the **read of the source** — surfaced as a
generic copy failure with no "permission" wording. It is still an FDA denial. (As of
v2.1.1 `doctor` classifies this message as a Full Disk Access failure and points here
rather than reporting "did not look permission-related".)

These are macOS denying access, not a bug in the server. The fix is always the
same: grant FDA to the host app and **fully restart it** (see above).

### Gotcha: the "host app" for a Claude-spawned server may be a *nested* bundle

If you granted Full Disk Access to `/Applications/Claude.app` (or to your
terminal), fully restarted, even rebooted — and osxphotos-backed tools **still**
fail with `Error copying …/Photos.sqlite …` while the exact same
`osxphotos.PhotosDB()` call succeeds when you run the venv Python directly — the
grant almost certainly landed on the wrong identity.

macOS attributes a locally-spawned MCP subprocess's file access to the
**responsible process**, which is not always the app icon you clicked:

- **Claude Code (CLI/desktop Code tab)** spawns MCP servers under a **per-version
  nested helper bundle**, not `/Applications/Claude.app`. Look for it at
  `~/Library/Application Support/Claude/claude-code/<version>/claude.app`. This
  bundle needs its **own** FDA grant, and it **silently resets on every Claude
  auto-update** — the tell is a new, un-checked lowercase **"claude"** row
  appearing in the Full Disk Access list.
- **A terminal-launched server** is attributed to the terminal app
  (Terminal/iTerm/VS Code), not to `node`.

Fix it: open **System Settings → Privacy & Security → Full Disk Access**, look for
a **"claude"** entry (distinct from "Claude") or add the nested
`…/claude-code/<version>/claude.app` bundle via **+**, toggle it **on**, then
restart the MCP server (a fresh session, or quit/relaunch the host). If it worked
before and broke after an update, re-check this list first — the grant was reset,
not lost for good.

### Still failing after granting every host app? Check whether TCC attributed it to `node` itself

Every fix above assumes responsibility climbs from the subprocess up to *some*
app — Claude Desktop, the nested Code bundle, or your terminal. On at least one
confirmed setup it didn't: TCC attributed the check directly to the `node`
binary, and none of the wrapper-app grants ever touched it, because
responsibility never climbed past `node` to see them.

Don't guess between the theories above — the macOS unified log is
authoritative. Reproduce the failure while streaming:

```
log stream --style compact --predicate 'subsystem == "com.apple.TCC"' --info
```

Look for a line like:

```
Handling access request to kTCCServiceSystemPolicyAllFiles,
from Sub:{/usr/local/bin/node}
Resp:{TCCDProcess: identifier=node, pid=…, responsible_path=/usr/local/bin/node, binary_path=/usr/local/bin/node},
ReqResult(Auth Right: Denied …)
```

If `Resp:` names `node` (not `claude.app`, not your terminal), grant FDA to the
**node binary itself**: **+** → ⌘⇧G → type the exact path from `responsible_path`
above (commonly `/usr/local/bin/node`, `/opt/homebrew/bin/node`, or a
pinned-runtime path) → toggle on → fully quit and relaunch the host app.

A stable, Developer-ID-signed Node build (check `codesign -dv $(which node)` —
look for a real `TeamIdentifier`, not `flags=0x2(adhoc)`) keeps this grant
across Node upgrades. An ad-hoc-signed build (common with some Homebrew
formulae) gets a new code identity on every rebuild, so the grant can need
re-doing after `brew upgrade`.

## Note: exporting iCloud-only originals also needs Photos automation

Full Disk Access covers reading and querying the library, and exporting any
original that is already **on disk**. But if a photo's original isn't downloaded
locally (Photos is using **Optimize Mac Storage**, so only an iCloud copy
exists), the `export` tool falls back to **Photos.app via AppleScript** to
download the original on demand.

That fallback is a separate permission: **macOS Automation control of Photos.app**
by the host process. The first time it runs, macOS may prompt you to allow the
host app to control Photos — approve it. You can also review/toggle this later
under **System Settings → Privacy & Security → Automation**. Photos.app must be
installed and signed in to iCloud for the on-demand download to succeed; if it
can't fetch the original, that photo is skipped with a per-UUID reason and the
rest of the export still proceeds.

See also: [Known Limitations](../README.md#known-limitations) in the README and
[LIMITATIONS.md](./LIMITATIONS.md).
