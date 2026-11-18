<h1 align="center">CoTeam</h1>

<p align="center"><sub><a href="./README.md">简体中文</a> · <strong>English</strong></sub></p>

<p align="center">
  <strong>An AI coding workspace for teams</strong><br/>
  Agents run on your team's server; you watch, chat and take over from your own Mac.
</p>

<h3 align="center"><a href="https://github.com/Tinghecui/dodoer-releases/releases/latest/download/dodoer-macos-arm64.zip"><ins>Download for macOS (Apple silicon)</ins></a> · <a href="https://github.com/Tinghecui/dodoer-releases/releases"><ins>All releases</ins></a></h3>

## What it does

- **One window for every agent**: Claude Code, Codex and others share the same chat view, with tool calls, changed files and diffs laid out clearly.
- **Local and server side by side**: on the start page pick "Work on this computer" or a server; several windows can stay open at once.
- **Lend this Mac to agents on the server**: let them open pages in your Chrome or run commands on your computer, and take it back with one switch.
- **Automatic updates**: the app tells you when a new version is out; click update and restart.

## Install

1. Download the package above, unzip it, and drag `dodoer.app` into Applications.
2. Before the first launch, run this once in Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/dodoer.app
   ```

   (The current packages are not signed with an Apple Developer ID yet; without this step macOS refuses to open the app.)
3. Open the app and pick "Work on this computer" on the start page, or connect to your team's server (below).

> Once installed, the app is still called dodoer in Applications. That is the old name; a later version will change it.

## Connect to your team's server

In your team portal, go to "My account" → "Desktop" and click "Open in the desktop app". The app asks once; confirm and it connects, with no address or token to type in.

## What this repository is

This is the **release repository** for the CoTeam desktop app and server: every version's packages and update manifests are published under [Releases](https://github.com/Tinghecui/dodoer-releases/releases).
The code here is synced automatically from the development repository so tests and builds can run on public machines. Development does not happen here, and commits or pull requests made here are not merged.

- `v1.x.y`: desktop app
- `cowork-codeg-vX.Y.Z`: server (upgraded by your server's administrator in the portal)

## Credits and license

CoTeam is built on the open-source project [Codeg](https://github.com/spacering-net/codeg) and its fork dodoer. Thanks to the authors of both.
Released under the [Apache License 2.0](./LICENSE).
