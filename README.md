# tokenmeter

tokenmeter counts your Claude Code and Codex tokens on your own machine.
It shows how much of your weekly limit you have used and where you are heading.
Its token counts come from local logs. It has no runtime dependencies.

Use it to:

- Show the Claude week percent on the Claude Code status line, with a forecast.
- Read Codex quota for a HUD.
- Count tokens for today, the week and the month, for each model.
- Show how much of the week each finished task used.
- Estimate how much of the week a new task will use.

## Install and run

Use Node 22.0 or newer. Install the package at a fixed version:

```sh
npm install --global @dean0x/tokenmeter@0.1.0
```

The examples below use the installed command `tokenmeter`.

From a source checkout, install the development dependencies first. The tests need Node 22.18 or newer.
Run `npm run build` before you run the command.

```sh
npm ci
npm run build
./bin/tokenmeter.js status
```

## Credentials and network access

tokenmeter needs no credentials. It does not read credential files or make HTTP calls itself.
The optional Codex limits read runs the installed Codex CLI, which may contact its service.
`record` and `statusline` start no other program.

tokenmeter never prints or stores text from your sessions.
It keeps numbers, the names of models, and short labels of folders.
A test plants a marker text in every text field of the sample logs.
The test checks that the marker is in no output and in no file of the data folder.

## Commands

Every command except `record` and `statusline` prints one line of JSON:

```json
{"schema":"tokenmeter.v1","ok":true,"data":{}}
```

On an error, the line is `{"schema":"tokenmeter.v1","ok":false,"error":{"code":"...","hint":"..."}}`.
The hint is a fixed text. It never holds input text.
The exit code is 0 for success, 2 for `usage_error` and 1 for every other error.

| Command | What it does |
|---|---|
| `tokenmeter collect` | Reads new lines of the logs and updates the data folder. |
| `tokenmeter status` | Prints the last result of `collect`, with the latest Claude quota and the `periods` (days, weeks and months). It never reads the logs. |
| `tokenmeter usage` | The same as `status`, with every model. `status` keeps the 8 busiest. |
| `tokenmeter tasks sync` | Reads task windows and open items from stdin. |
| `tokenmeter tasks` | Prints the tasks of the last result, with their shares of the week. |
| `tokenmeter estimate` | Reads open items from stdin and prints an estimate for each. |
| `tokenmeter doctor` | Prints counters only, to check that the logs are read. |
| `tokenmeter record` | A filter for a status line. It copies stdin to stdout and stores the rate limits. |
| `tokenmeter statusline` | A status line. It stores the rate limits and prints one short line. |
| `tokenmeter hud` | Prints the stored Codex quota. It can start a background refresh. |
| `tokenmeter config` | Prints the effective `app_server` setting. Add `app_server on` or `app_server off` to set it. |

`collect` and `doctor` take `--claude-root` and `--codex-root`.
The defaults are `~/.claude/projects` and `~/.codex/sessions`.
Every command except `record`, `statusline` and `hud` takes `--data-dir`.
`status` and `usage` also take `--week-start`. See "Days, weeks and months".
An unknown command or flag gives `usage_error`.
`tasks sync` can also write one warning line to stderr, for a folder collision. See "The folder match".

`collect` stops after a fixed amount of bytes and time.
A large backlog takes several passes.
While it lasts, `status` shows `collect.state: counting` and a `progress_pct`.

## The data folder

The folder is the first of these that is set:

1. The flag `--data-dir`.
2. The variable `TOKENMETER_DATA_DIR` (an absolute path; a relative value is ignored).
3. On macOS: `~/Library/Application Support/tokenmeter`.
4. Elsewhere: `$XDG_STATE_HOME/tokenmeter` (an absolute path), or `~/.local/state/tokenmeter`.

tokenmeter makes the folder with mode 0700 and its files with mode 0600.
It refuses a folder that is a link, that belongs to another user, or that others can write to.
It also refuses a folder whose parent folder others can write to, unless the parent has the sticky bit (as `/tmp` has).
Then the code is `data_dir_unsafe`, and nothing is written.

The folder holds the token counts from 7 days before the start of the current month, in UTC. See "The horizon" in the section about the folder match.
It also holds the totals of each local day for the last 400 days (`days.json`). See "Days, weeks and months".
It also holds the quota samples, the task windows, the task history and the estimate log.
It holds no path of a log file, no session id and no text from a session.

## Error and empty states

| State | JSON code | What it means |
|---|---|---|
| `tokenmeter` was not found | `not_installed` | A tool that calls tokenmeter reports this when the command is missing. tokenmeter itself never prints it. |
| Never collected | `not_collected` | Run `tokenmeter collect`. |
| Scan backlog | ok, `collect.state: counting` | The first scan is not finished. `progress_pct` shows how far it is. |
| Damaged store file | `store_corrupt` | `collect` stops and writes nothing. Move the data folder away and run `collect` again. The counts come back from the logs. The task history does not. |
| Store newer than the program | `store_newer` | A newer tokenmeter wrote the data. Nothing is written. Update tokenmeter. |
| Store file too large | `store_too_large` | A store file would pass its size limit. `collect` stops and writes nothing. Move the data folder away and run `collect` again. The counts come back from the logs. The task history does not. |
| Damaged or newer days file | ok, `periods: null`, `periods_error` | `status` and `usage` print all their other fields. `periods_error` is `store_corrupt` or `store_newer`. `collect` stops with that code. Delete `days.json` to clear it. See "Days, weeks and months". |
| Data folder unsafe | `data_dir_unsafe` | The folder is refused. See the section about the data folder. |
| No Claude samples | ok, `quota.source: none` | No status line has run `record` or `statusline` yet. |
| Codex folder missing | ok, `root: root_missing` | You have not used Codex yet. |
| No calibration | ok, `calibration: null` | Shares of the week are not ready yet. |
| Rough calibration | ok, `confidence: rough` | Shares are shown, with a low confidence. |
| Estimate fall-back | ok, `basis: wide` | No feature fit or pair fit beats the finished tasks of the same type, or all finished tasks. The range is wide and has a low confidence. |
| No estimate basis | ok, `basis: none` | Fewer than 3 finished tasks have a cost, the calibration is not ready, or the costs are too equal to score a range. |
| Estimate log damaged | ok, `estimate_log_damaged` above 0 | `collect` did not read a month file of the estimate log, or did not list the data folder in full. See the section about the estimate log for the steps that clear it. |
| Estimate log at the cap | ok, `estimate_log_at_cap` above 0 | A month file of the estimate log holds 1 MiB and takes no new line. See the section about the estimate log. |
| Another `collect` runs, or took the lock over | `lock_held` | Nothing was changed. Try again later. |
| Bad command, flag or input | `usage_error` | The exit code is 2. |
| Node older than 22.0 | `node_too_old` | Install a newer Node. |
| Unexpected failure | `internal_error` | No text of the failure is printed. |

A window of the Claude quota that has no usable value shows a reason code instead:
`missing`, `unsafe`, `too_large`, `bad_shape`, `out_of_range`, `stale`, `absent`, `bad_percent` or `bad_reset`.
A display should show `?` for it.

## What it counts

Only the `five_hour` and `seven_day` windows of the status line count.
Model-scoped weekly limits (Opus, Sonnet) and Claude Desktop transcripts do not.

The Claude quota comes from the status line, with `record` or `statusline`.
`collect` gets Codex quota from the session logs. The [HUD refresh](#codex-quota-for-a-hud) can also read current limits from Codex.

The forecast uses one reading of the week percent.
The burn is the percent used, divided by the hours from the week start to the time of that reading.
The run-out time and `at_reset_pct` use the same burn and the same reading.
`forecast.at` is the time of that reading, in milliseconds. It is the last time the percent was seen, also for Claude.

A token count has five columns: input, cache write (5 minutes), cache write (1 hour), cache read and output.
A weighted count adds them with the weights 1, 1.25, 2, 0.1 and 5.
A message that appears twice in the logs counts once.

A Codex event can state a cache write in `cache_write_input_tokens`.
tokenmeter moves that amount from the input column to the cache write (5 minutes) column.
It moves at most the input that the cache did not serve, so the raw total does not change.
A missing value counts as 0.
A value that is not a valid token count also counts as 0.
Then `collect` counts the event in `codex_cache_invalid`, and the event stays.
Codex has no 1-hour cache write, so that column is always 0.
A Codex row that `collect` stored before this rule keeps its old split. tokenmeter does not count it again.

## Tasks and tags

A task is a window of time in some folders.
`tokenmeter tasks sync` reads this JSON from stdin:

```json
{
  "windows": [
    {"label": "T-1", "start": "2026-11-03T07:00:00Z", "end": "2026-11-03T09:00:00Z",
     "match": {"folders": ["/work/alpha"]}, "tags": {"type": "feature"}, "features": {"size": 120}}
  ],
  "open": [{"key": "I-1", "tags": {"type": "feature"}, "features": {"size": 150}}]
}
```

A window without `end` is open. Folder paths become keys at once. No path is stored.
Each sync replaces the whole list of windows, so a window that you leave out is gone.
Send every finished window again with each sync, as long as it ended in the current month or in the 7 days before it.
Older windows are dropped by `tokenmeter` itself.
A label, a key, a tag name and a tag value use only letters, digits and `. _ : -`, up to 64 characters.
An entry with other characters is refused and counted.

Give each task a `type` tag, for example `feature`, `bug` or `docs`.
A task can also carry features, which are numbers. See "Features".
An open item can carry a `stage` tag, the work stage of the item, for example `issue`, `plan` or `review`.
`collect` stores the stage in the estimate log, and the self-check shows its numbers for each stage.
See "The estimate log and the self-check".
`tokenmeter estimate` reads `{"items": [{"key": "I-1", "tags": {"type": "feature"}, "features": {"size": 150}}]}` from stdin.
It uses the type and the features to find similar tasks. See "The estimate".

A task or item can have a `project` tag, for example `"tags": {"project": "alpha"}`.
If it has no `project` tag, tokenmeter uses its `repo` tag. If it has both, `project` wins.
Tag names and values are case-sensitive. tokenmeter never takes the project from a folder, a folder key or a path.
An item with neither tag uses only the shared candidates.

Choose a short, neutral value. tokenmeter keeps project values in task history, `status.json` and the estimate log.
No command removes a project value from these records on its own.

### Features

A feature is a name and a number.
Send features in the `features` object of a window or an open item.
`tokenmeter estimate` takes them in its items in the same way.
A window, an item and a finished task each keep at most 16 features.

- A name has 1 to 16 characters. It starts with a lower-case letter. The other characters are lower-case letters, digits or `_`.
- The names `elapsed_hours`, `constructor`, `type`, `all`, `none` and `spent` are reserved. tokenmeter refuses them.
  The last four are basis names of the estimate (see "The estimate"), so no feature can take them.
  A stored window, item or task that already has a feature `spent` stays. tokenmeter reads it without that feature and counts it in `features_refused`.
  The freeze drops the feature from the task history.
  A line of the estimate log that holds the feature `spent` is not valid any more. See "The estimate log and the self-check".
- A value is a finite number from 0 to 1e12. tokenmeter keeps it to six decimal places.

tokenmeter refuses a bad feature alone and counts it. The window, the item or the task stays.
A good feature after the 16th is refused too. A `features` value that is not an object counts as one refused feature.
Three counts show refused features. Each command shows its own count:

- `tokenmeter tasks sync` shows `refused.features`. It counts the bad features in the windows and the open items of that input.
- `tokenmeter estimate` shows `refused_features`, next to `refused`. It counts the bad features in the items of that input. `refused` counts the items that are refused.
- `collect` shows `features_refused` in `counters`. It counts the bad features that this `collect` finds in the stored windows, open items and finished tasks. This number is for one `collect`. It is not a running total. `doctor` shows the number of the last `collect`.

`tasks sync` and `estimate` do not count the features of an item or a window that they refuse or that repeats an earlier one.
`tasks sync` stores only good features. So after a normal sync, `features_refused` is 0. It is more than 0 only when a stored file holds a bad feature.
A user who reads `features_refused` alone does not see the bad features that `tasks sync` or `estimate` refused.
A window or a task line that has no `features` reads as having none. This is true for data that an older tokenmeter wrote.

### The estimate

The estimate learns from the finished tasks. It uses their weighted tokens of the Claude week.
`collect` and `tokenmeter estimate` use the same rules.
A candidate is one way to predict the cost of an item:

- A feature fit: a line from one feature to the cost. It needs 8 finished tasks that carry the feature.
  The selector scores at most 16 feature names. It takes the names with the most tasks, and the ties go by name.
- A pair fit: a plane from two features to the cost. It needs 40 finished tasks that carry both features.
  It counts only when it beats both single fits by at least 5 percent.
  The selector makes pairs only from the 3 best single fits.
- Type: the finished tasks of the same type as the item. It needs 3 of them.
- All: all finished tasks. It needs 3.
- None: no candidate gives a range.

A fit works on the log of the cost and the log of 1 plus the feature value.
An item can use a candidate only when it has the features or the type that the candidate needs.

A finished task that cost less than 0.1 percent of the week is under the floor. It stays out of the fits.
The floor is a part of the week, so it moves when the size of the week changes. A task near it can enter or leave the fits.
With fewer than 3 finished tasks at or over the floor, every item gets the basis `none`, unless it is on the `spent` basis.
The project range ends, the `spent` basis, the self-check and the queue use no floor.

The selector scores each candidate with leave-one-out.
For each finished task, it predicts the cost from the other tasks.
The score is the median error of the candidate, divided by the median error of all on the same tasks.
The item takes the candidate with the lowest score.
If two scores are equal, the simpler candidate wins: all, then type, then a feature fit, then a pair fit.

The range is an honest 80% range. It is meant to hold the cost of 8 of 10 new tasks.

- For a feature fit or a pair fit, the range is the prediction, moved by the 10th and the 90th percentile of the leave-one-out errors of the fit.
  A fit with fewer than 9 tasks has too few errors for these percentiles.
  Then each end moves outward by half of the extreme error.
- For type and all, the range is the 10th to 90th percentile of the costs of the group.

A project needs at least 9 finished tasks at or over the floor for its own range.
The selector tries at most 8 projects: those with the most fit tasks, with ties by name.

The gate compares leave-one-out scores on the same project tasks.
A shared candidate enters the gate if it covers at least 9 project fit tasks and both scores are valid.
At least one shared candidate must enter the gate.
The project score must be at most 90% of each such shared score. Otherwise the shared candidates stay.
A shared feature or pair fit that beats the project score on the tasks it covers stays where it applies.

The project range uses the costs of all its finished tasks with a cost, even below the floor.
For `m` such tasks, take the costs at ranks `floor((m + 1) / 10)` and `ceil(9 * (m + 1) / 10)`, from rank 1.
Both ends must be finite. The low end must be positive and no greater than the high end.

For the typical and budget costs, blend the fit tasks of the project with all fit tasks.
With `n` project fit tasks, give the project group weight `n / (n + 9)` and the shared group the rest.
Each group splits its weight evenly among its tasks.
Clamp the weighted 50th and 80th percentiles into the range. The budget is at least the typical cost.

The 80% rank rule applies only to items on the project basis. A kept fit uses its own range.
The rank rule does not account for the gate or changes in task costs over time.
The `spent` basis and the queue sum stay shared.

A fit does not predict outside the feature values that it learned from.
When a feature value of an item is above the largest or under the smallest value of the finished tasks of the fit, the range is the range at that largest or smallest value.
A pair does this for each of its two features.
The typical cost and the budget cost (see below) are the ones at that value too.
The range then reads rough: its basis word is `wide`, and `basis_name` and both ends stay.
A value equal to the largest or smallest value is not clamped.
The estimate log keeps the basis of the fit, so a clamp writes no new line.

The basis word says how much to trust the range:

- `similar`: a feature fit or a pair fit.
- `wide`: type, all, a project range, `spent` or a rough range. The range has low confidence.
  An open range or a range with a clamp is rough.
- `none`: no basis. The estimate has no range.

An item that has not started keeps a wide range: the signals at intake are weak.

`basis_name` says what the range rests on. It is a feature name, two feature names with `+` between them for a pair, `type`, `all`, `spent` or `none`.
In a snapshot that an older tokenmeter wrote, `basis_name` is `null` until the next `collect`.
A tool that maps `basis_name` to its own words shows its default word for `spent` until it learns the name.

An estimate with a basis has these fields, in this order, after `key`, `subscription`, `basis` and `basis_name`:

- `low_pct` and `high_pct`: the range, in percent of the week.
- `raw_low` and `raw_high`: the same range in raw tokens.
  The raw range is the weighted range times the median raw tokens for each weighted token of the finished tasks of the candidate.
  So the two ranges have the same factor between their ends.
  For a project range, the median uses all project tasks with a cost. For `spent`, it uses all finished tasks.
  In a snapshot that an older tokenmeter wrote, `raw_low` and `raw_high` are `null` until the next `collect`.
- `count`: the number of finished tasks that the range rests on. A project range counts only the fit tasks of the project.
- `typical_pct`: the typical cost, in percent of the week.
  For shared type, shared all and `spent`, it is the median cost.
  For a feature or pair fit, it is the prediction with the median leave-one-out error applied.
- `budget_pct`: the cost to plan with, in percent of the week. It uses the 80th percentile instead of the 50th.
- `basis_project`: the project value when the estimate uses the project range. Then `basis` is `wide` and `basis_name` is `all`.
  This field is `null` for a shared range, a kept fit or `spent`. tokenmeter reads an absent snapshot field as `null`.

So `low_pct`, `typical_pct`, `budget_pct` and `high_pct` are in this order, from the least to the most.
An open range (see below) has `null` for `high_pct`, `raw_high`, `typical_pct` and `budget_pct`.
In a snapshot that an older tokenmeter wrote, `typical_pct` and `budget_pct` are `null` until the next `collect`.
An estimate with no basis has none of these fields.

In `status`, a running item has a low end rule.
Its open window has the key of the item as its label.
The low end of the range is never below the weighted tokens that this window used so far.
When the item has used more than the high end, the range is open.
Then `high_pct` and `raw_high` are `null`, and `low_pct` is the cost so far: read it as `low_pct` and more, for example `19%+`.
An open range reads rough: its basis word is `wide`, also on a feature fit or a pair fit.
`basis_name` keeps the name of the basis.
The estimate log keeps the basis of the fit, so an item that runs past its range writes no new line.
`tokenmeter estimate` reads no window, so it has no low end rule.

When a running item has used 0.5 percent of the week or more, it takes the `spent` basis instead of any other.
Its range is the 10th to 90th percentile of the costs of the finished tasks that cost at least as much as the item has used.
`typical_pct` and `budget_pct` are the median and the 80th percentile of the same costs, and `count` is their number.
The 0.1 percent floor does not apply to these tasks.
With fewer than 5 such tasks the range is open from the cost so far, as above.
The rule needs at least one finished task. With none, the item has no basis.
`basis_name` is `spent`, and the basis word is `wide`.
Under 0.5 percent, the low end rule above holds.

The rule has no memory. It reads the cost so far and nothing else.
So an item can leave the `spent` basis when the size of the week grows, and a new window with the same key starts its cost so far again.
`collect` writes one log line for each change of the basis. A larger cost so far on the `spent` basis writes no new line.
`tokenmeter estimate` never shows this basis.

### The queue

`status` shows `queue` in `data`, right after `pool`. It is the sum of the costs of the open items, in percent of the week:
`{"count":3,"expected_pct":12,"low_pct":8,"high_pct":18,"likely_low_pct":10,"likely_high_pct":14,"spent_pct":2}`.

- `count`: the number of open items, from 0 to 500.
- `expected_pct`: the sum of the mean costs of the items.
  The mean cost of an item is the mean of the costs that it draws from (see below).
  An item that counts as its cost so far adds that cost.
- `low_pct` and `high_pct`: the 10th and the 90th percentile of the drawn sums.
- `likely_low_pct` and `likely_high_pct`: the 25th and the 75th percentile of the same sums. They lie inside `low_pct` and `high_pct`.
- `spent_pct`: the sum of the costs so far of the items.

The queue draws 4000 sums. In each draw, every open item takes the cost of one finished task, and the draw adds the costs.
An item with no cost so far takes any finished task that has a cost.
A running item takes one of the finished tasks that cost at least as much as the item has used.
When fewer than 5 finished tasks cost that much, the item counts as its cost so far and takes no draw.
The draws use a fixed generator with a fixed start. So the same input always gives the same numbers.
The queue uses no floor: every finished task that has a cost counts.

The sum depends on the items that the input sends. The queue counts only the open items of the last `tasks sync`.
An item that you leave out of the sync adds nothing.

- With no open item, `count` is 0 and every sum is 0.
- When the size of the week is not known, or fewer than 3 finished tasks have a cost, `count` stays and the six sums are `null`.
- With more than 500 open items, `queue` is `null`.
- In a snapshot that an older tokenmeter wrote, `queue` is `null`. So is a `queue` that is not valid.
  A `queue` that is not valid does not make the store corrupt.

### The folder match

A folder key is a folder path with each character other than a letter or a digit changed to `-`.
The key keeps at most the first 200 characters of the path.
A token row goes to the windows on its longest existing folder key.
A key exists when a window of the last sync holds it.
The key of the row itself is the longest. If no window holds it, the longest key that is the start of the row key and ends before a `-` wins.
So a real subfolder still matches its parent, while no window of the last sync holds the key of the subfolder.
Only the windows on that key that cover the time of the row get the row. Several of them split it evenly.
If none covers the time, nobody gets the row. A shorter key is never a second choice.

These limits are known. tokenmeter does not fix them:

- Folder collisions. Two different paths can give one key. For example, `/work/a-b` and `/work/a/b` both give `-work-a-b`.
  The rows of both folders merge. The key rule stays the same.
  `tokenmeter tasks sync` warns when two different paths of one sync give one key.
  Only the windows that it stores count: the open ones, and the ones that ended inside the horizon.
  tokenmeter cleans each path first (`.`, `..`, a double `/` and a trailing `/`). Two paths that are equal after that are one path.
  The warning is in the `collisions` field of the JSON output:
  `"collisions": {"keys": 1, "windows": ["T-1", "T-2"]}`.
  `keys` is the number of keys that 2 or more different paths gave. `windows` holds the labels of the windows that hold such a key.
  With no collision, it is `{"keys": 0, "windows": []}`.
  With a collision, `tasks sync` also writes one line to stderr, and the exit code stays 0:
  `tokenmeter: warning: 1 folder key comes from 2 or more different paths (windows T-1, T-2). Their rows merge. See "The folder match" in the README.`
  The output holds no path and no key.
  Only `tasks sync` warns. `status` and the other commands show no warning, because no path is stored.
  tokenmeter cannot see a collision between a folder of the logs and a folder of the sync, because it changes the folder of a log row to a key at once and keeps no path.
  So it does not warn when a log folder `/work/a-b` merges with a sync folder `/work/a/b`.
  A row of the sibling folder `/work/p1-x` goes to a window on `/work/p1`, when no window holds the key `-work-p1-x`.
  When a window holds that key, it takes the rows of the real subfolder `/work/p1/x` as well. tokenmeter gives no warning for these two cases.
- The 200-character cut. Two paths with the same first 200 characters give one key.
  A folder deeper than 200 characters matches the cut key.
- The horizon. tokenmeter keeps token rows from 7 days before the start of the current month, in UTC.
  A task that began before that day counts only the rows after it.
  `tokenmeter tasks sync` drops a window that ended before the horizon.

### Frozen tasks

`collect` freezes a finished task into the task history. It does this once, more than 1 hour after the task ended, and only when the scan has no backlog.
The history keeps the totals and the features that the task had at that time.
A frozen row keeps its stored values.
A later change of a rule does not change it. For example, an earlier Codex row keeps its old cache split.
A feature that you send after the freeze does not reach the frozen task.
There is no command to cost a frozen row again, and no command to unfreeze it.

### The estimate log and the self-check

`collect` keeps a log of the ranges that it showed. The self-check compares these ranges with the real cost of the finished tasks.

The log has one file for each month in the data folder: `estimates-YYYY-MM.jsonl`. The month is the UTC month of the line time.
A line has these fields:

- `at`: the time, in milliseconds.
- `key`, `basis` and `basis_name`: as in the estimate.
- `features`: the names of the features of the item, at most 16. It holds no values.
- `stage`: the `stage` tag of the item, or `null` when the item has none. A line with the basis name `spent` has the stage `run`.
- `basis_project`: the project value for a project range, or `null` for a shared range or no basis. An older line without this field reads it as `null`.
- `low` and `high`: the range in weighted tokens. Both are `null` with no basis.

`collect` checks the latest line for the key. It writes one line if there is no match for the key.
It also writes one if the basis, basis name, feature names, stage or `basis_project` differs.
A repeat with the same values writes none.

The first use of a project range writes one extra line per affected open item, even if the basis name stays the same.
Each later gate change that moves an item to or from a project range writes one more line.

A change of stage with the same basis writes one new line.
While an item is on the `spent` basis, its stage is `run` whatever its tag says. So a change of its `stage` tag writes no line.
An item that loses its `stage` tag writes a line with `stage` `null`.
A range that moves is not a change. An item with no basis gets a line too.
`collect` writes the snapshot first, then it appends the new lines.
A crash between the two steps loses the new lines of that pass. The next `collect` writes them again.

A month file takes no new line when it holds 1 MiB.
tokenmeter checks the size before each append, so a file can pass the cap by one line.
`collect` appends the lines after it releases its lock. So each `collect` that runs at the same time can pass the cap by one line.
`collect` reads at most the 24 newest month files.
It does not read a file that is a link, that belongs to another user, that the group or others can access, or that is too large.
It counts such a file in `estimate_log_damaged`. A line that is not valid is skipped. It is not damage.
A line is not valid when it has more than 16 feature names, or when a feature name is not valid, for example the reserved name `spent`.
It is not valid either when its basis name is a pair that holds a name which is not valid, for example `spent+size`, or when its `stage` is neither `null` nor a label.
This is true for the lines that an older tokenmeter wrote too.
A line with no `stage` reads as `stage` `null`.
A line is not valid if `basis_project` is neither `null` nor a label. It is also not valid if it has a project value but no basis.
`collect` refuses a line that cannot read back as written. It counts that line in `append_failed` and leaves the file unchanged.
It counts a data folder with more than 1000 names, or a data folder that it cannot list, in `estimate_log_damaged` too.
The append follows the read. `collect` writes no line to a month file that it did not read.
It writes no line at all when it could not list the data folder in full.
It counts each such line in `append_failed`, and the file does not change.
The next `collect` writes the line when the file can be read again.
`estimate_log_at_cap` counts the month files at or above the cap.
Both counters are in `counters` of `collect` and `doctor`.
The result of `collect` also has an `estimate_log` object:
`{"appended":0,"refused_at_cap":0,"append_failed":0,"pruned":0,"prune_failed":0}`.
These are the lines written, the lines refused at the cap, the lines that failed, the month files deleted and the deletes that failed.
The snapshot and `doctor` do not hold this object.

To clear `estimate_log_damaged`, find the cause and run `collect` again:

- A month file that the group or others can access: run `chmod 600` on it.
- A month file that is a link, or that belongs to another user: move it out of the data folder.
  The lines in a file that you move are lost for the self-check. `collect` writes a new line for each open item.
- A month file that is too large (more than 1 MiB plus 64 KiB): move it out of the data folder.
- A data folder with more than 1000 names, or that you cannot list: remove the names that do not belong to tokenmeter, or correct the permissions of the folder.

The count goes to 0 in the first `collect` that reads all the files.
Until then, all fields of `self_check` are `null`.
`collect` deletes no month file and writes no line to a month file that it did not read.

After the append, `collect` deletes the month files that it does not need.
For each of the 30 most recent finished tasks, it keeps the month of the latest line that links to the task, and the month of the latest line of each stage that links to it.
For each open item, it keeps the month of the latest line, and the month of the latest line of each of its stages.
It also keeps these months for each window of the last `tasks sync` that has ended and is not in the task history yet: the latest line before the end, and the latest line of each stage before the end.
Each of these also keeps the month of the latest line that has not the basis name `spent`, because the top level of the self-check reads that line.
The freeze runs more than 1 hour after the end, and only when the scan has no backlog. After the freeze, those lines score the task.
It deletes only month files that are older than the oldest month that it keeps. A month between two kept months stays, also when no line needs it.
It deletes only regular files with the exact name `estimates-YYYY-MM.jsonl`. It never deletes a link, a folder or another name.
With fewer than 30 finished tasks, it deletes nothing. It deletes nothing, too, when the log is damaged or when there is no line to keep.

For a recent finished task, an open item and an ended window, the prune keeps the month of the latest line of each stage, not only the month of the latest line.
So an old line of an early stage can keep an old month file.
Two limits bound the growth: the 1 MiB cap of a month file, and the 24 month files that `collect` reads.
The first `collect` after the update writes one line for each open item that has a `stage` tag, because its stage changes from `null` to the label.
This growth happens once.

`status` shows `self_check` in `data`:
`{"n":10,"hit_rate":0.8,"error_factor":1.4,"bias":1.2,"band_low":0.5,"band_high":1,"width":2.5,"useful_rate":0.5,"stages":{"issue":{"n":5,"hit_rate":0.6,"error_factor":1.6,"bias":1.3,"band_low":0.4,"band_high":1,"width":3,"useful_rate":0.4}},"projects":{}}`.

- `n`: the tasks, among the 30 most recent finished tasks, that had a range in the log before they ended.
  A line belongs to the first finished task of its label that ended after the line time. A task uses the latest line that belongs to it and has not the basis name `spent`.
  A task with only `spent` lines is not counted in `n`.
  If a label is used again and its basis does not change, `collect` writes no new line, so the second task is not scored.
- `hit_rate`: the part of these tasks, from 0 to 1, whose cost fell inside the logged range. An honest 80% range gives about 0.8.
- `error_factor`: the median of the larger of cost over middle and middle over cost. It is 1 or more.
  The middle is the geometric middle of the logged range.
- `bias`: the median of middle over cost. With an even number of tasks, it is the geometric mean of the two middle values.
  Above 1, the ranges sit above the cost: the estimates are high. Below 1, they sit below the cost: the estimates are low.
  It is `null` when it is not a finite number above 0.
- `band_low` and `band_high`: the normal range of `hit_rate`, from 0 to 1.
  If the ranges are honest 80% ranges, `hit_rate` lands inside this band 95 times in 100.
  A `hit_rate` inside the band is what chance looks like. It is noise, not a fault.
  A `hit_rate` outside the band is a sign of a fault: the ranges do not hold what they claim.
  For example, with 5 tasks the band is 40 to 100 percent. So 3 hits in 5 tasks (60 percent) is normal.
  For 10 tasks the band is 50 to 100 percent. For 30 tasks it is 19/30 to 28/30, which is 63 to 93 percent.
  The exact rule: the band is the 2.5% and the 97.5% quantile of the hits of `n` tasks that each hit with the chance 0.8, divided by `n`.
  The values are exact, not an approximation.
- `width`: the median of the high end over the low end of the logged ranges of these tasks. It is 1 or more.
  A smaller width means a tighter range. An open range is logged with equal ends, so it counts as 1.
- `useful_rate`: the part of these tasks, from 0 to 1, whose cost fell inside the logged range and whose high end was at most 4 times its low end.
  A range that is wider than that hits, but it does not help a week plan. So `useful_rate` is never more than `hit_rate`.
- `stages`: the same eight values for each stage that a line of these 30 tasks names. A stage object has `n`, `hit_rate`, `error_factor`, `bias`, `band_low`, `band_high`, `width` and `useful_rate`.
  A stage uses the latest line of that stage that belongs to the task, over the same 30 most recent finished tasks.
  A line with no stage does not count in `stages`. The top level uses the latest line, with or without a stage, but skips `spent` lines.
  A `spent` line has the stage `run`, so it counts in that stage only.
  An item with the stage tag `run` and an item on the `spent` basis count in the same `run` row. The row is one of the 8 places, like any stage.
  The `run` row measures the spent range at the start of the rule: the log keeps one line for each basis and stage, so a larger cost so far writes no new line.
  A task can count in several stages, so the `n` of the stages can add up to more than the `n` above.
  A stage whose lines all have no basis shows `n` 0 and `null` values.
  `stages` shows at most 8 stages: the ones with the most scored tasks, and the ties go by name. They are in name order.
  A name of only digits, such as `2`, comes before the other names, in number order.
  A stage past the eighth is not shown. Its lines stay in the log.
- `projects`: the same eight fields for each project, from the top-level scores of the same 30 recent tasks.
  A shared line can count for the project of its task. A line that names a different project can count at the top level but not in `projects`.
  The rule still links lines by label. It does not look for a different line when the project does not match.
  The map keeps at most 8 projects with the most scored tasks, with ties by name.
  It is `{}` when no scored task has a project that meets these rules.

`hit_rate`, `error_factor`, `bias`, `band_low`, `band_high`, `width` and `useful_rate` are `null` under 5 scored tasks.
This applies at the top level and in each stage and project.
`width` is `null` too when it is not a finite number. The other values stay.
`stages` is `{}` when `collect` read the log and no line with a stage belongs to one of these tasks, for example before the first item with a `stage` tag finishes.
When `collect` cannot read the log in full, all fields are `null`. This includes `stages` and `projects`.
In a snapshot that an older tokenmeter wrote, `self_check` is `null`.
A snapshot of an older version can lack the newer values of `self_check`, at the top level and in the stages.
One version has only `n`, `hit_rate` and `error_factor`. A later one has no `width` and no `useful_rate`.
A value that is not there reads as `null`, and the other values stay.
A wrong value in `self_check` makes the whole `self_check` `null`, except for `stages` and `projects`.
A bad or absent map reads as `null`. The other fields stay.
A band that is not the band of its `n` is a wrong value. So is a number, or a `stages` object, when `n` is `null`.
So is a `width` under 1, a `useful_rate` outside 0 to 1, and a `useful_rate` above `hit_rate`.
When `n` is `null`, `projects` reads as `null` without a change to the other fields.
`tokenmeter estimate` does not read or write the log.

### Going back to an older tokenmeter

Release tokenmeter first, before any tool that sends more than 6 features or a `stage` tag.
If you go back to an older tokenmeter:

- It skips a log line with more than 6 feature names.
- It keeps 6 features for each task in the task history. Its freeze writes the history again, so the features 7 to 16 of a task are lost.
- It reads a task history of more than 8 MiB as `store_corrupt`. The current limit is 16 MiB.
- It does not know `days.json`. If a `collect` of the newer tokenmeter stopped in the middle of its write, the older one reports `store_corrupt`. Run the newer one again first.
- It does not update `days.json`, so the days of the file are out of date after it ran. Delete `days.json` after a run of an older tokenmeter.
  The next `collect` of the newer tokenmeter builds the file again with the backfill. See "The backfill" for what the backfill can find.
- It accepts a feature named `spent` and the stage `run`. Do not send a feature `spent`: the newer tokenmeter refuses it.
- It reads each field of an estimate and of the self-check by name. So it drops `typical_pct` and `budget_pct`, and `width` and `useful_rate`.
- A build before 0.2.0 drops `basis_project` from estimate rows and `projects` from `self_check`. It ignores `basis_project` in the log.
- It does not know `queue`. It passes `queue` through unchecked, as it finds it in the snapshot, until its next `collect` writes a snapshot without it.

`tokenmeter tasks sync` refuses a window or an open item with a `stage` tag that is not a label, and counts it.
Such an item has no estimate and writes no line to the log.

## Week shares and the pool

Each entry of `tasks[].shares[]` in `status` and `tasks` has these fields:

- `weighted` and `raw`: the tokens since the start of the task.
  `raw` adds the five columns with no weight. `weighted` adds them with the weights. Codex has no 1-hour cache write, so that column counts as 0.
- `today_weighted`, `week_weighted` and `month_weighted`: the weighted tokens inside today, the current week and the month.
  These are the periods of `subscriptions[].tokens`. Hours that two tasks share are split evenly.
  The history of a finished task keeps its totals, not its tokens inside the periods. If the window of a finished task is not in the last sync,
  each of these is `null` for a period in which the task ended, and `0` for a period that began after the task ended.
- `week_pct`: `week_weighted`, divided by the weighted tokens of the week of the subscription, times its `seven_day` percent.
  It is never more than that percent. It is `null` when:
  - the percent is unknown, or its week has ended (a Codex percent that was read before the reset time);
  - the percent is of another week than the tokens. For example, a Claude reading of the next week came after the last `collect`. The next `collect` fixes this;
  - the week has no tokens, or `week_weighted` is `null`.

By default the two subscriptions are separate.
Then `pool` is `{"mode":"separate"}`, and `pool_pct` of each task is `null`.

To read the two subscriptions as one pool, set two variables:

```sh
export TOKENMETER_POOL=combined
export TOKENMETER_POOL_WEIGHTS=claude=0.5,codex=1
```

Each weight is a number above 0 and up to 1.
Then `pool` is `{"mode":"combined","weights":{"claude":0.5,"codex":1},"used_pct":<number or null>}`.
`used_pct` is the sum of each weight times the `seven_day` percent.
`pool_pct` of a task is the sum of each weight times the `week_pct` of its shares.
Each of them is `null` when a percent that it needs is unknown. A percent whose week has ended is unknown.
A combined pool with missing or bad weights is separate.
`tokenmeter doctor` shows `pool.reason`: `pool_weights_missing`, `pool_weights_bad`, or `pool_mode_bad` for an unknown mode.

## Days, weeks and months

`collect` keeps the totals of each local day in the file `days.json`.
A day is a calendar day in the time zone of the `collect` process. A 15 minute row belongs to the day that holds its start time.
A day of 23 or 25 hours (a clock change) is one day. A day with no tokens has no row in the file.
The file keeps the last 400 days, today included. `collect` deletes the older days. The 15 minute rows keep their shorter horizon.

A day row holds the five raw columns of each subscription and of each model, with at most 40 models for each day.
The models with the most weighted tokens stay. The columns of the subscriptions keep every model.
Inside the horizon of the 15 minute rows, a day row is the sum of its 15 minute rows. `collect` changes both together.
A day that is older than that horizon is final. A later `collect` does not change it.
If you change the time zone, the days already stored keep their dates. New rows use the new zone.
Damage to `days.json` gives `store_corrupt` in `collect`, a newer version gives `store_newer`, as for every other store file.
If only `days.json` is damaged, delete that one file. The next `collect` builds it again with the backfill. The other store files stay as they are.

### The backfill

The first `collect` that finds no `days.json` runs a backfill once. It marks the file with `"backfilled": true` and does not run again.
The mark `"cutThrough"` is `null` when the backfill read everything. Otherwise it holds the last day that the backfill may not have covered whole.
The backfill fills the days from all the data that tokenmeter still has:

- Every `buckets-YYYY-MM.json` file in the data folder, also the files of months that are past the horizon of the 15 minute rows.
  The backfill skips a damaged file of a month before the horizon, because `collect` never reads it. It marks the backfill as cut.
  A damaged file inside the horizon stops the `collect` with `store_corrupt`.
- The lines of the logs that are older than that horizon. These are the logs that `collect` reads. The backfill adds no other source.
  It reads each file from the start, for the last 400 days. It counts a line only when its day has no row in the bucket files, or when the line is before the first bucket row.
  So a line that the bucket files hold is not counted twice. A Claude message that appears twice counts once, with its largest output, for each UTC day.
  A Codex event counts once for each key. It does not count again when the dedupe days of the 15 minute horizon already hold its key.

The backfill reads the files that hold only old lines first (a file time before the horizon). Then it reads the files with a newer file time.
It does not read a Codex file in a folder more than one day after the first day of the horizon: that file has no old line.
It keeps its rows in memory and changes no 15 minute row.
It reads at most 1 GiB (at most 200 MiB from one file), for at most 120 seconds, and it keeps at most 500000 message keys.
It checks the bytes and the time between two files. So it can pass the time limit by the read of one file.
If one of these limits ends it, the result of `collect` has `days_backfill.cut: true`. The days that it did not reach stay missing.
A line that a tool already deleted from its log cannot be counted.
The result of `collect` has `days_backfill`: `{"ran":true,"files":12,"rows":3400,"cut":false}`.
These are: if it ran, the files it read, the entries it added to the days, and if a limit ended it. It is not in the snapshot.
An entry is a Claude message, a Codex key, or a Codex event with no key.

### The periods of status and usage

`status` and `usage` add `periods` and `periods_error`. They read `days.json` when they run, so `periods` is not in the snapshot.
A folder with no `days.json` gives empty lists.
A damaged or newer `days.json` does not stop the command. All the other fields stay, `periods` is `null`, and `periods_error` is `store_corrupt` or `store_newer`.
`periods_error` is `null` when `periods` is there.

```json
{"week_start":"sun","days":[],"weeks":[],"months":[],"cut":{"days":0,"weeks":0,"months":0}}
```

Each list is oldest first and starts at the first day with data. It has no hole after that day: a day with no tokens is a row of zeros.
A row has these fields:

- `start`: the first local day, as `YYYY-MM-DD`. A month row uses its first day.
- `start_ms` and `end_ms`: the local midnight of the start, and of the next period.
- `full`: `true` when the store covers every day of the row. All of these must hold:
  - The row ended before the end of the last `collect` (`collect.at`). A row that ended after it may miss tokens.
  - The last `collect` read every line (`collect.state` is `ok`). With a scan backlog, no row is full.
  - The row starts after the first day with data, because the logs or the horizon may have cut its start.
    So the week and the month of that day are not full.
  - The row starts after `cutThrough` of `days.json`, when the backfill was cut. A week or month that holds such a day is not full.
- `current`: `true` when now is inside the row. A current row is never full. Its totals are the totals so far.
- `subs`: `claude`, `codex` and `total` (the sum of the two). Each is a total.
- `models`: the total of each model, by the name that `status` shows, the largest first.
  A day row has at most 40 models. A week row and a month row have at most 20.
  Two subscriptions with one model name add into one entry. The totals of `subs` keep every model.

A total has three fields: `raw`, `in` and `out`.
`raw` has the form of `subscriptions[].tokens.today`: the five columns and `weighted`. The Codex cache write columns are `null`.
`in` is the input and all the cache columns added with no weight. `out` is the output. Both are whole numbers.

A week and a month are the sum of their days, so every total agrees with the days.
The week starts on the day of `week_start`. `status --week-start sun|mon|tue|wed|thu|fri|sat` sets it.
Without the flag it is the first weekday of the locale of the process (`Intl.Locale` week info), and Sunday when the locale has none.
Any other value of the flag gives `usage_error`.

The lists have caps: 410 days, 60 weeks and 15 months, the newest rows.
The reader of the status caps its input at 1 MiB. So the whole output of `status` and `usage` stays under 900 KiB.
The other fields of the output take their bytes first. The periods get the bytes that are left.
The months take them first, then the weeks, then the days. A list that does not fit leaves out its oldest rows.
`periods.cut` gives the number of rows that the byte budget left out of each list: `days`, `weeks` and `months`.
Each count is 0 when the budget leaves out no rows. Rows outside the fixed count caps do not count.
With the most models and the longest names in the 400 days, the weeks and the months together take about 375 KB.
A store with 5 models in each day takes about 720 KB for all three lists.
So the oldest day rows drop first when the other fields are large.
Use the weeks and the months for the whole horizon, and the days for the recent time.

## Time

Every time in the JSON is in milliseconds since 1970.
Today and the month follow the time zone of the process.
The days of `days.json` follow the zone of the `collect` process.
`TZ` sets the zone, for example on a remote server: `TZ=Europe/Berlin tokenmeter collect`.

## Three ways to use it

### 1. Alone, as the Claude Code status line

Set the status line command in the settings of Claude Code:

```json
{
  "statusLine": { "type": "command", "command": "/path/to/tokenmeter/bin/tokenmeter.js statusline" }
}
```

Claude Code runs the command and gives it a JSON text on stdin.
`tokenmeter statusline` stores the rate limits. Then it prints one line:

```
Claude wk 40% | 70% by reset | today 2.7k, 3m ago
Claude wk 80% | 140% by reset, runs out in 24h | today 2.7k, 3m ago
```

- `wk` is the Claude week percent. It shows `?` when the value is unknown or old.
- `by reset` is the forecast percent at the reset time, at the burn of this week so far.
- `runs out in` shows only when the week limit runs out before the reset.
- `today` is the weighted Claude tokens of today. It comes from the last `collect`, and the age is the age of that result.

With no result of `collect`, the line has the week and the forecast only.
With no data folder, or an unsafe one, the line is `tokenmeter: no data`.
The line is plain ASCII and at most about 80 characters.
The command prints nothing on stderr and always exits 0.
It does not run `collect`. Schedule `collect` as shown at the end of this section.

To try it, run: `echo '{}' | tokenmeter statusline`.

To undo, remove the `statusLine` key, or put your old value back.

### 2. In front of any other status line command

You can keep your own status line command and add tokenmeter in front of it.
Set the command to this, with your own command in place of the placeholder:

```sh
{ tokenmeter record 2>/dev/null || cat; } | { <your status line command>; }
```

`record` copies stdin to stdout at once, byte for byte, and ends stdout at the end of stdin.
Your command sees the same input as before.
Then `record` stores the rate limits. It prints nothing of its own and always exits 0.
The `|| cat` part runs only when the shell cannot start `record`. Then `cat` passes the input on.
Use the full path of the script if `tokenmeter` is not on the PATH of Claude Code.

To undo, set the command back to your old value.
To check, run `tokenmeter status`.
The Claude quota should show an age of a few minutes.

### 3. The JSON commands, for other tools

Other tools can call the commands and read the JSON.
Start the command with an argument list, not through a shell.
Set `TOKENMETER_DATA_DIR` if the tool needs its own folder.

```sh
tokenmeter status
tokenmeter usage
tokenmeter tasks sync < tasks.json
tokenmeter estimate < items.json
```

`status` answers from the last result in well under 3 seconds. It never reads the logs.
Check `ok` and `schema` before you use `data`.
The names of the fields are in snake_case. Times are in milliseconds since 1970.

### Codex quota for a HUD

Run `tokenmeter hud` with no flags or stdin. From a source checkout, run `npm run build` first.
The command returns the stored quota at once. It does not write to the data folder or wait for Codex.

Read `data.hud` for the format version (1). Read `data.codex` for the quota, or `null` if no usable reading exists.
The `windows` list can contain 300-minute and 10080-minute windows. Each window reports a used percent (`pct`), reset time, and reading time.
Its `source` is `rollouts` for session logs or `appserver` for a Codex reply. The quota also reports the newest reading time and `limit_reached`.

If the newest reading is missing or at least 60 seconds old, a HUD call can start a detached refresh.
The first refresh creates the data folder if necessary. The refresh reads only the tails of recent Codex session logs.
It normally runs at most once per minute per data folder, and only in response to a HUD call.
A full disk or simultaneous HUD calls before the first refresh takes its lock can cause extra starts.

The Codex limits read is on by default. It needs Codex 0.56.0 or newer on `PATH` and does not run on Windows.
The Codex lookup and the child process `PATH` use only folders that you or root own.
Group and other users must not have write access to these folders or to the Codex executable.
You or root must also own the executable and its folder.
The refresher checks `codex --version` when necessary and runs `codex app-server` to request account rate limits over stdin and stdout.
It tries the limits read at most once per minute per data folder. Some failures extend the wait before another attempt.

```sh
tokenmeter config
tokenmeter config app_server off
```

The off switch stops Codex starts. The refresh still reads the session logs.
Run `tokenmeter config app_server on` to enable the limits read again.

### Keep the numbers fresh

The status line commands do not run `collect`.
Run it every 5 minutes. This is a line for `crontab -e`:

```
*/5 * * * * PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin /path/to/tokenmeter/bin/tokenmeter.js collect >/dev/null 2>&1
```

On macOS you can use a launchd job with `StartInterval` set to 300 instead.

## Tests

Build the command before you run a test that calls it.

```sh
npm run build
node --test test/cli.test.ts
npm run typecheck
```

The tests keep every write inside a folder of their own, `state-test/`.
They never use your home folder or your real data folder.
