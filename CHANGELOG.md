# Changelog

## [Unreleased]

- Show Codex account token totals in `status` and `usage`, with use from other machines and clients. Use local log totals when account data is absent or too old.

## 0.2.0

- The Claude week and 5 h percentages can now drop within one reset period after about 10 minutes without confirmation of the higher value.

- Estimate task costs by project when the project range beats the shared candidates. Shared feature fits can still apply.
- Show `basis_project` in estimate rows and log lines. Report `self_check.projects` for the same recent tasks as the top-level check.
- Add `periods.cut` to `status` and `usage`. It counts the rows that the byte budget leaves out of each list.
