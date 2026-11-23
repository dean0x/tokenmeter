# Changelog

## [Unreleased]

- Count use from a local proxy that sends Claude Code requests to Codex. Task shares and calibration include this use. If the proxy reports cache reads as input, the weighted counts can be too high.
- Run a one-time re-read of Claude log files after the update, within the normal scan budget. The ledger field `rev` records the parser revision. Rows outside the store horizon stay out, and frozen tasks keep their totals.
- For the Codex week and month, use the account for each UTC date it reports and the logs for the other dates. The account can report a date about one day late, so `source` can be `mixed`. With no account date in the period, use the log total. Codex log totals include cache writes.

## 0.3.0

- Show Codex account token totals in `status` and `usage`, with use from other machines and clients. Use local log totals when account data is absent or too old.

## 0.2.0

- The Claude week and 5 h percentages can now drop within one reset period after about 10 minutes without confirmation of the higher value.

- Estimate task costs by project when the project range beats the shared candidates. Shared feature fits can still apply.
- Show `basis_project` in estimate rows and log lines. Report `self_check.projects` for the same recent tasks as the top-level check.
- Add `periods.cut` to `status` and `usage`. It counts the rows that the byte budget leaves out of each list.
