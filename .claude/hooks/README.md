# Session hooks

## `session-start-git-sync.sh` — SessionStart

Stops sessions from starting on a stale clone and then reporting confidently on
code that has already moved. Registered in `../settings.json` with no `matcher`,
so it runs for every session-start source.

### Behaviour

It **always fetches** (`git fetch --prune --tags origin`, retried 2s/4s on
network failure). Fetch is read-only, so this is always safe, and it is what
makes every `origin/*` ref in the clone truthful.

It **only advances the checkout by fast-forward**, and only when `source` is
`startup` or `resume`. It never merges, rebases, resets or stashes.

| Situation | What happens |
| --- | --- |
| Behind, clean tree, `startup`/`resume` | `git merge --ff-only` to the upstream |
| Behind, but `clear`/`compact`/`fork` | Fetch only — files must not change mid-task |
| Uncommitted changes | Fetch only — the local work is not this hook's to discard |
| Diverged (local commits *and* behind) | Fetch only — merging could reorder or lose commits |
| Detached HEAD | Fetch only — a detached checkout is a deliberate revision |
| No upstream configured | Fetch only, and says so |
| Fetch failed | Reports the refs as untrustworthy |
| `jq` not installed | Fetch only — the event type is unreadable, so it is assumed mid-task |

Every case it declines to advance is reported through `additionalContext`, so
the agent is told how stale the tree is instead of silently assuming it is
current. That reporting is the point as much as the fast-forward is.

It **always exits 0**: a network blip should be reported honestly, not used to
block the session from starting.

### Notes

- Runs synchronously, so the tree is correct before the first turn. Async would
  reintroduce the race this exists to remove.
- Worst case it delays session start ~141s (3 fetch attempts at a 45s timeout).
  Override with `NSO_HOOK_FETCH_TIMEOUT`.
- Cloud sessions do not read `~/.claude/settings.json`, which is why this lives
  in the repo. It only applies to sessions started from a branch that contains
  it — once on the default branch, it applies everywhere.
- `jq` is the only dependency, and it is only needed to read `source` from the
  payload and to emit the JSON. Without it the hook still fetches and still
  reports, but it never fast-forwards: an unreadable event type is treated as
  possibly `compact`, because defaulting to `startup` would re-enable exactly
  the mid-task file rewrite the `source` check exists to prevent.

### Testing

Point it at a deliberately rewound clone:

```sh
git clone <url> /tmp/stale && cd /tmp/stale && git reset --hard HEAD~5
printf '{"source":"startup","cwd":"/tmp/stale"}' \
  | CLAUDE_PROJECT_DIR=/tmp/stale bash .claude/hooks/session-start-git-sync.sh
```

To exercise the `jq`-missing path, run it against a `PATH` built from
everything it needs *except* `jq`. It should report the lag and leave `HEAD`
exactly where it is, even on `source=startup`:

```sh
d=$(mktemp -d)
for b in bash git cat head awk date sleep timeout; do ln -s "$(command -v $b)" "$d/$b"; done
printf '{"source":"startup","cwd":"/tmp/stale"}' \
  | env -i HOME="$HOME" PATH="$d" CLAUDE_PROJECT_DIR=/tmp/stale \
      bash .claude/hooks/session-start-git-sync.sh
```
