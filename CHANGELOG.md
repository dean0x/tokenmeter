# Changelog

## [Unreleased]

- The Claude week and 5 h percentages can now drop within one reset period after about 10 minutes without confirmation of the higher value.

## 0.2.0

- Estimate task costs by project when the project range beats the shared candidates. Shared feature fits can still apply.
- Show `basis_project` in estimate rows and log lines. Report `self_check.projects` for the same recent tasks as the top-level check.
- Add `periods.cut` to `status` and `usage`. It counts the rows that the byte budget leaves out of each list.
