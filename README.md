# gnutix's fork of Parallel Code

This is [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) with my fixes on
top. Its `main` is upstream's `main` plus each fix below, merged here as soon as it is done and
sent upstream as a pull request at the same time. A workflow merges upstream's `main` into it every
night, so it never falls behind.

For what Parallel Code is and how to install it, see
[upstream's README](https://github.com/johannesjo/parallel-code#readme).

## Bugs fixed

Newest first. The pull request link shows whether upstream has merged it yet.

| Area      | What was wrong                                                                                                                                                                                                                                                                                                               | Pull request                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Prompt    | Turning off "Show prompt input box below terminal" did not last. Asking about a mind-map or reasoning-graph branch, picking an element in the browser preview, or any prompt the app filled in (review rework, tour, CI fix) turned it back on for good. These now show the box for that one task, until the prompt is sent. | [#373](https://github.com/johannesjo/parallel-code/pull/373) |
| Board     | With a task open beside the board, pressing the board button again did nothing. It now closes the side panel and puts focus back on the task's card.                                                                                                                                                                         | [#370](https://github.com/johannesjo/parallel-code/pull/370) |
| Finish    | A task whose work went out on another branch, leaving its own branch empty, could only be closed with the × in its title bar: Finish offered a disabled "Merge into local main" and Push. It now offers Close task.                                                                                                          | [#368](https://github.com/johannesjo/parallel-code/pull/368) |
| Terminal  | A setup script that exited 0 showed "Setup script failed (0)" and an error notification, and an agent that exited cleanly counted as failed: node-pty's signal `0` on a clean exit reached the renderer as the truthy string `"0"`.                                                                                          | [#366](https://github.com/johannesjo/parallel-code/pull/366) |
| Resources | The Resources panel left out the CPU of commands that start and exit between two samples (hooks, status-line scripts, short test runs). With a dozen agents it showed 27% of the machine while it was really at about 50%.                                                                                                   | [#363](https://github.com/johannesjo/parallel-code/pull/363) |
| PR checks | A task showed no PR chip when its PR, pushed under another branch name, was merged before the app saw it open, or when the agent never printed its link.                                                                                                                                                                     | [#362](https://github.com/johannesjo/parallel-code/pull/362) |
| Electron  | The app pinned Electron 42, which is end-of-life and gets no more Chromium or Node security fixes. Upgraded to 45, with terminal paste moved to the new clipboard API. _Sent upstream only, not merged into this fork's `main` yet._                                                                                         | [#361](https://github.com/johannesjo/parallel-code/pull/361) |
| Chat      | With Chat turned off in Settings, clicking the greyed-out Chat button raised a red alert under the task header that nothing cleared. A Chat button that cannot open now does nothing and shows a not-allowed cursor.                                                                                                         | [#360](https://github.com/johannesjo/parallel-code/pull/360) |
| Prompt    | The "Needs you" line was laid over the prompt box: a scrolled draft ran under it, and the text jumped 20–24 px each time it came and went. It now has its own row above the text.                                                                                                                                            | [#357](https://github.com/johannesjo/parallel-code/pull/357) |
| Usage     | In the usage popover, each meter row wrapped and shrank by a different amount, so the bars ended at different points and "72% left" broke over two lines. The meters now share one grid.                                                                                                                                     | [#355](https://github.com/johannesjo/parallel-code/pull/355) |

## Features

Not bugs, but merged here too.

| Area       | What it adds                                                                                                                                                                               | Pull request                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Task panel | A pill on the boundary of the two-column task view hides the side column, giving the agent terminal the whole width, and brings it back.                                                   | [#369](https://github.com/johannesjo/parallel-code/pull/369) |
| Agents     | An opt-in setting (Settings > Agents > Prompt cache) pings an idle Claude Code conversation every 55 minutes, so coming back to it reads the prompt cache instead of writing it all again. | This fork only                                               |

## Fork-only files

- `README.md`: this file. The nightly sync keeps it when upstream changes theirs.
- `.github/workflows/sync-upstream.yml`: the nightly merge of upstream's `main`. On a conflict it
  pushes nothing and opens an issue listing the files.
