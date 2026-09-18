# DSH Sync · Pick up on another computer

Sync DeepSeek Harness sessions, attachments, settings and workspace files through your own Git repository. Use a private GitHub repository for personal data.

[中文](README.md) · [npm](https://www.npmjs.com/package/dsh-sync-plugin) · [Report an issue](https://github.com/dpskk2/dsh-sync-plugin/issues)

## Quick start

You need a working DSH Web installation, Git, access to GitHub, and preferably [GitHub CLI](https://cli.github.com/). The package declares Node.js ≥ 20; Node.js 24 is recommended for compressed session handling. A complete cross-platform compatibility matrix is not yet available.

```sh
dsh plugin --profile web add dsh-sync-plugin
gh auth login
gh auth status
```

Choose GitHub.com and HTTPS during login. Restart DSH, then click **⟳ 同步** (Sync) in the sidebar. With no remote configured, the plugin tries to create or reuse `dsh-sync` under the logged-in account. Newly created repositories are private; check the visibility and purpose of any existing repository before syncing.

In **设置 → 同步** (Settings → Sync), verify the repository URL and a successful result, including workspace results. A local snapshot alone does **not** mean data was uploaded. Workspace file syncing is on by default; turn off **同步工作区文件** before the first sync if you only want sessions and settings.

## Connect another computer

1. Install DSH, Git, GitHub CLI and this plugin on the second computer, then restart DSH.
2. Sign in to the same GitHub account. The default `dsh-sync` repository can be reused automatically. For a custom repository, use the same `remote` and `branch` on both computers.
3. Click Sync, check the result, then restart DSH to reload settings and session indexes.
4. Configure API credentials and install required plugin / project dependencies on that computer. `node_modules` is not transferred.

Create a test conversation on A, sync A, sync B, and verify it appears on B. Repeat in the other direction. For everyday use, sync before starting and after finishing on each computer.

## Manual configuration

Create or edit `dsh-sync.json` inside the DSH data directory: `~/.dsh` by default, `%USERPROFILE%\.dsh` on Windows, or the directory selected by `DSH_HOME`. Merge these fields into any existing configuration:

```json
{
  "remote": "https://github.com/YOUR_USERNAME/dsh-sync.git",
  "autoRepo": false,
  "mode": "manual"
}
```

Configure Git authentication separately; do not put access tokens in the URL. SSH is supported with an already configured key and host trust. Restart DSH after changing the sync mode. Automatic mode defaults to a 300-second interval and also responds to session activity.

## Scope and limits

- Sessions, attachments, settings, plugin manifests, workspace files and user-provided patches are included unless excluded by ignore rules.
- The dedicated `.credentials.yaml` file, dependencies and selected machine-local state are excluded. This is **not** a general secret scanner: secrets in conversations, attachments, `.env` files or other project files can still be uploaded.
- Session logs and supported configuration files are merged automatically. Competing values of the same field resolve to one value. Unresolved ordinary-file conflicts prefer the local version and attempt to back up remote history. Review the result; this is not a guarantee against data loss.
- Sync is not live collaborative editing or an independent disaster backup. Existing data on the second computer participates in two-way merging.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No Sync button | Check the `web` profile, restart DSH and refresh the browser |
| Git not found | Verify `git --version` under the same system user; restart DSH after installing Git |
| Local snapshot only | Check `gh auth status`; retry after about 60 seconds, or set `remote` manually |
| Authentication error | Run `gh auth login` again under the same system user; Git runs non-interactively |
| Session missing on B | Sync A first, then B; check remote / branch and errors, then restart B |
| Auto mode does not start | Restart DSH after saving the mode; ensure `enabled` is not `false` |

More detailed documentation is currently in Chinese: [setup](docs/getting-started.md), [configuration](docs/configuration.md), [sync scope](docs/sync-content.md).

## Update or remove

```sh
dsh plugin --profile web update dsh-sync-plugin
dsh plugin --profile web remove dsh-sync-plugin
```

Restart DSH after updating. Removing the plugin does not automatically delete local data or the remote repository. MIT licensed.
