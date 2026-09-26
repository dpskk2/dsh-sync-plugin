<div align="center">

# DSH Sync

### Another computer. The same work.

**Bring your conversations, attachments, settings and project files along.**
Personal multi-computer sync for DeepSeek Harness, through your own private GitHub repository.

[![npm](https://img.shields.io/npm/v/dsh-sync-plugin?color=2563eb)](https://www.npmjs.com/package/dsh-sync-plugin)
[![MIT](https://img.shields.io/badge/license-MIT-slateblue)](LICENSE)

[Quick start](#quick-start) · [Connect another computer](#connect-another-computer) · [中文](README.md) · [Issues](https://github.com/dpskk2/dsh-sync-plugin/issues)

</div>

## Keep the conversation. Bring the project.

Move from your desktop to your laptop with the context and files you need to continue.

| What you want | What comes with you |
| --- | --- |
| Continue the conversation | Sessions, attachments and workspace associations |
| Continue the project | Actual workspace files, with a local relocation option |
| Repeat less setup | Model / interface settings and plugin manifests; configure credentials and install dependencies per computer |
| Control where data goes | Your GitHub repository, with private visibility checked before upload |
| Spend less time syncing | Manual or automatic sync; switching modes in Settings takes effect immediately |

## Quick start

You need a working DSH Web installation, Git, access to GitHub, and [GitHub CLI](https://cli.github.com/). The package declares Node.js ≥ 20; Node.js 24 is recommended for compressed session handling. A complete cross-platform compatibility matrix is not yet available.

```sh
dsh plugin --profile web add dsh-sync-plugin
gh auth login
gh auth status
```

Choose GitHub.com and HTTPS during login. Restart DSH, then click **⟳ 同步** (Sync) in the sidebar. With no remote configured, the plugin tries to create or reuse `dsh-sync` under the logged-in account. It verifies that an existing repository is private and refuses to upload if visibility cannot be confirmed.

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

Configure Git authentication separately; do not put access tokens in the URL. GitHub CLI must be installed and authenticated to verify repository visibility, including for manually configured remotes. SSH is supported with an already configured key and host trust. Other Git hosts are not supported for cloud uploads. Switching modes in Settings takes effect immediately. Restart DSH after editing scheduling options directly in the file. Automatic mode defaults to a 300-second interval and also responds to session activity.

## Daily use

Sync before starting and after finishing on each computer. To automate it, select automatic mode in Settings → Sync and save. Switching back to manual cancels future scheduled runs; a sync already in progress finishes normally.

## Compatibility

The package declares DSH Web ≥ `0.1.5-rc.3` via `engines.dsh`. This minimum is not a claim that every newer host version has been tested. Local Git replica tests and UI / scheduler tests are reproducible with `npm test`; authenticated GitHub two-device validation is separate. See the [validation record](docs/release-0.12.5-validation.md).

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
| Auto mode does not start | Allow up to the configured interval (300 seconds by default); ensure `enabled` is not `false` and host overrides do not force manual mode |

More detailed documentation is currently in Chinese: [setup](docs/getting-started.md), [configuration](docs/configuration.md), [sync scope](docs/sync-content.md).

## Update or remove

```sh
dsh plugin --profile web update dsh-sync-plugin
dsh plugin --profile web remove dsh-sync-plugin
```

Restart DSH after updating. Removing the plugin does not automatically delete local data or the remote repository. MIT licensed.
