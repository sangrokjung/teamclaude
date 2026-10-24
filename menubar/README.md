<p align="center">
  <strong>English</strong> ·
  <a href="README.ko.md">한국어</a>
</p>

# CC Menubar

The macOS menu-bar app and click-to-open usage panel for TeamClaude and TeamCodex.
It lives in this repository next to the proxy and the TUI; no separate desktop app is needed.
It is a native Swift/AppKit executable with no Electron, Tauri, React or npm runtime packages.

## The panel

Clicking the menu-bar item opens a 520pt panel. The header shows the title, the time of the data, and how many accounts
need a person ("To fix N"). Below it are five tabs.

| Tab | Contents |
|---|---|
| Overview | Accounts routable now, four lanes (Claude Fable, Codex, Grok, agy), the Claude pool's weekly usage strip, accounts to fix, weekly burn outlook |
| Claude | Accounts grouped by state. Resets are stated once in the column heads. Click a row to expand plan, concurrency, request count, per-window resets and the re-auth, measure and plan-record actions |
| Codex | The TeamCodex pool (5-hour and 7-day bars with their own resets per account), recovery buttons, and Codex usage on this Mac |
| Burn | Subscription spend and per-service verdicts, what to do first, ccusage usage (cost) |
| CLI | Grok and agy quotas, Higgsfield credits, and the words used for missing values |

Bars turn amber from the 98% routing threshold. The thin sky-blue tick on a bar is how much of that window has elapsed;
a fill ahead of the tick means the window will fill before it resets.
The footer has Refresh (R) and the action list (⌘K): measure accounts, import the Claude Code account, add Claude or Codex
OAuth accounts, restart the TeamClaude server, open at login (.app builds only), and quit. Number keys 1–5 switch tabs.
The visual rules (colors, type, spacing) are in [DESIGN.md](DESIGN.md).

## Language

The UI is in Korean or English. If the first preferred language in System Settings is Korean, the panel is Korean;
otherwise it is English. All UI strings live in `Sources/L10n.swift`. For testing you can pin the language:

```sh
CC_MENUBAR_LANG=en menubar/.build/cc-menubar --dashboard-snapshot <status.json> /tmp/panel.png
```

## Development and install

Requires Apple Silicon macOS 13+, Xcode Command Line Tools (Swift) and Python 3.
Run from the repository root.

```sh
npm run menubar:test
npm run menubar:build
npm run menubar:install
# to install a build you already verified
npm run menubar:install -- --binary "$PWD/menubar/.build/cc-menubar"
```

`menubar:build` saves a candidate to `menubar/.build/cc-menubar` only after the tests and snapshots pass.
The snapshots cover the table render, an empty HOME with no tools (a not-installed notice in every tab), and language
(no Hangul in the English panel, the reference copy in the Korean panel).
It does not touch the running app. Install backs up and atomically replaces `~/Applications/cc-menubar/cc-menubar`
and registers the `com.qjc.cc-menubar` LaunchAgent. That path is independent of the development checkout, so building an
old branch does not change the running panel. Existing account config, keychain, usage cache and UserDefaults are kept.

The test runner pins `CC_MENUBAR_LANG=ko` because existing assertions check Korean copy.
On a busy host, run tests and builds through your organization's qgate or an isolated macOS worker.
Install the menu-bar app on the Mac with the logged-in GUI session. The proxy is never restarted.

To look at the panel, use the offscreen snapshot. It renders one image per tab and prints the drawn strings as
`TEXT <tab>=` lines.

```sh
python3 menubar/Tests/make_dash_fixture.py /tmp/fixture.json --codex
menubar/.build/cc-menubar --dashboard-snapshot /tmp/fixture.json /tmp/panel.png            # five tabs
menubar/.build/cc-menubar --dashboard-snapshot /tmp/fixture.json /tmp/panel.png --tab claude --expand acct-13
```

## Install from a release

Download from GitHub Releases. macOS 13 or later, universal (Apple Silicon and Intel).
The app is not signed or notarized with an Apple developer ID, so you have to open it once by hand.

1. Download `CC-Menubar-<version>-macos-universal.zip` and the matching `.sha256` file.
   In that folder, `shasum -a 256 -c CC-Menubar-<version>-macos-universal.zip.sha256` should print `OK`.
2. Unzip and move `CC Menubar.app` to `/Applications`.
3. The first time, right-click the app in Finder → Open → Open.
   If macOS says the app "is damaged and can't be opened", clear the quarantine flag and open it again:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/CC Menubar.app"
   ```

4. In the panel footer's "Actions ⌘K" list, choose "Open at login" to start it when you log in.
   That writes `~/Library/LaunchAgents/dev.teamclaude.cc-menubar.plist`; choosing it again removes the file.
   The item only appears in the `.app` build and is separate from the `npm run menubar:install` setup above.

### When a tool is missing

If a tab's tool (TeamClaude, TeamCodex, Codex CLI, Higgsfield, ccusage, Grok, Antigravity CLI) is not on the Mac,
its card shows a "Not installed" or "No data" notice instead of an error, and the menu-bar title leaves it out.
The plan collector is optional; without its state file the Burn tab shows "Collector not installed (optional)".
If ccusage is installed but a run fails (exit code, timeout, unreadable output), the Usage card shows "Usage Needs check"
with the cause instead of "No data". When earlier values exist they stay on screen, and the Usage card and its header get
a "refresh failed (cause) · previous values" note.

The menu-bar app does not inherit your shell PATH, so it looks for executables itself, in this order:

1. Override `CC_MENUBAR_<TOOL>_BIN` (if the path is wrong it shows "Not installed" instead of trying elsewhere)
2. The existing candidate paths used by the internal install
3. Login shell `/bin/zsh -lc 'command -v <tool>'` (2-second limit, remembered while the app runs; the shell runs in its own
   process group, and the whole group is ended on timeout or when a child started by the shell config keeps the output open)
4. Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) → npm global prefix → fnm, nvm, Volta default aliases → `~/.local/bin`

If a tool is installed but shows as missing, set its path. The startup log has one `TOOL <name>=<path>` line per tool.

| Variable | For |
|---|---|
| `CC_MENUBAR_TEAMCLAUDE_BIN`, `CC_MENUBAR_TEAMCODEX_BIN` | teamclaude, teamcodex CLI |
| `CC_MENUBAR_NPX_BIN` | npx used to run ccusage |
| `CC_MENUBAR_HIGGSFIELD_BIN`, `CC_MENUBAR_GROK_BIN`, `CC_MENUBAR_AGY_BIN`, `CC_MENUBAR_CLAUDE_BIN` | each CLI |
| `CC_MENUBAR_TEAMCLAUDE_PORT`, `CC_MENUBAR_TEAMCODEX_PORT` | default port when the config has none (3456, 3457) |
| `CC_MENUBAR_TEAMCLAUDE_LABEL` | launchd label of the TeamClaude proxy (default `com.qjc.teamclaude`) |
| `CC_MENUBAR_LANG` | pin the UI language (`ko` or `en`, for testing) |

An app launched from Finder does not see shell variables. Set them with `launchctl setenv CC_MENUBAR_GROK_BIN /path/to/grok`
and reopen the app (cleared on reboot), or put them in the login item plist's `EnvironmentVariables`.
The launchd label can also be set with `defaults write dev.teamclaude.cc-menubar teamClaudeLaunchdLabel <label>`
(the environment variable wins). If the label is not registered with launchd, "Restart TeamClaude server" does not use
kickstart: when the server is down it starts `teamclaude server` in the background, and when it is running it leaves it alone.

### Building a release (maintainers)

```sh
bash menubar/package-app.sh 1.0.0
```

This compiles arm64 and x86_64 separately, joins them with `lipo`, and writes `menubar/.build/CC Menubar.app`,
`menubar/.build/dist/*.zip` and `*.sha256`. It only ad-hoc signs (`codesign -s -`). Pushing a `menubar-v<version>` tag runs
`.github/workflows/menubar-release.yml`, which tests, packages and creates a draft Release; a person publishes it.
Running the workflow by hand (workflow_dispatch) without a tag only uploads the artifacts and creates no Release.

## What lives here

- `Sources/`: menu bar, panel (overview, account pools, usage, subscriptions, burn outlook) and the string table
- `DESIGN.md`: the panel's visual rules
- `Tests/`, `run-tests.sh`: Swift/Python regression checks and snapshots
- `../scripts/subscription-monitor.py`, `subscription-monitor-browser.js`: the optional plan collector
- `build.sh`, `install.sh`: standalone build and install
- `package-app.sh`: universal `CC Menubar.app` (zip and sha256) for public releases

Account data comes from `~/.config/teamclaude.json`, `~/.config/teamcodex.json` and the local server state.
External CLIs (Grok, Agy, Higgsfield, ccusage) are only used for their own cards.
The plan collector is optional, needs the existing browser tool and qgate, and is not started by the menu-bar install.
If an existing collector LaunchAgent points at an old repository, move both the script path in its `ProgramArguments`
and its `WorkingDirectory` to this repository. Live mailbox checks are opt-in.

## Origin and known limits

Migrated from `menubar/` and the two plan-collector scripts at commit `ff70e27742208d4eea0900e98945abcc9810d9fa`
of `sangrokjung/cc-visualizer`. Original author: Sangrok Jung.
This repository is now the source of truth for the menu bar; the desktop app in the original repository is not built or
shipped by this project.

The runner reports two availability methods (a second-vs-day boundary check and an old local QA hash check) as
known-red. Mailbox checks are opt-in. The migration did not widen the exception list or loosen assertions.

The panel shortcuts (R, 1–5, ⌘K) are received by 1pt-tall menu items that carry key equivalents, because custom views
do not receive key events while a menu is tracking. Offscreen snapshots cannot exercise that path; check it in the real menu.
