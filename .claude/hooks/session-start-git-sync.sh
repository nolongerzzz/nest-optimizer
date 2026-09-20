#!/bin/bash
# SessionStart hook: make sure the local clone is not stale before the agent
# does any work.
#
# Why this exists: sessions were repeatedly starting on clones that were days
# behind origin, and then reporting confidently on code that had already
# changed. Asking every kickoff to remember "please fetch first" is not a fix.
#
# What it does:
#   - always `git fetch` (safe, read-only; makes every origin/* ref truthful)
#   - advances the checkout ONLY by fast-forward, and only when the session is
#     actually beginning (source=startup|resume)
#   - never merges, rebases, resets or stashes. If it cannot fast-forward
#     cleanly it says so loudly instead of guessing.
#   - reports the outcome back into the system prompt via additionalContext,
#     so the agent knows the freshness of what it is looking at even when the
#     update could not be applied.
#
# Always exits 0: a network blip must not block the session, it must just be
# reported honestly.

set -uo pipefail

export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true
export GCM_INTERACTIVE=never

FETCH_TIMEOUT="${NSO_HOOK_FETCH_TIMEOUT:-45}"
LOG=""
STATUS="ok"          # ok | attention
SUMMARY=""

log()  { LOG+="${1}"$'\n'; }
note() { STATUS="attention"; }

# stdin is the hook payload; .source tells us why the session started.
#
# Reading it needs jq. Without jq the event type is simply unknowable, and
# guessing "startup" would hand back MAY_ADVANCE=1 for every event - including
# 'compact', where fast-forwarding rewrites files underneath work already in
# progress. That is the exact race this hook is built to avoid, so a missing
# jq degrades to a value that never advances: fetch, report, leave the tree be.
INPUT="$(cat 2>/dev/null || true)"
HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

if [ "$HAVE_JQ" -eq 1 ]; then
  SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo startup)"
else
  SOURCE="unknown-no-jq"
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ] && [ "$HAVE_JQ" -eq 1 ]; then
  PROJECT_DIR="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
fi
[ -n "${PROJECT_DIR:-}" ] && cd "$PROJECT_DIR" 2>/dev/null

emit() {
  # One JSON object on stdout, nothing else, or additionalContext is lost.
  local ctx="$1" msg="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg ctx "$ctx" --arg msg "$msg" \
      '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx},systemMessage:$msg}'
  else
    # No jq: exit-0 plain stdout is still read as context.
    printf '%s\n' "$ctx"
  fi
  exit 0
}

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
[ -n "$(git remote 2>/dev/null)" ] || exit 0

BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"
OLD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
OLD_DATE="$(git log -1 --format=%cI HEAD 2>/dev/null || echo '')"

# ---------------------------------------------------------------- fetch
# Retry on transient network failure: 2s then 4s. Worst case ~141s, which is
# the ceiling on how long this hook can delay a session start.
FETCH_OK=0
delay=2
for attempt in 1 2 3; do
  if timeout "$FETCH_TIMEOUT" git fetch --prune --tags --quiet origin >/dev/null 2>&1; then
    FETCH_OK=1; break
  fi
  [ "$attempt" -eq 3 ] && break
  sleep "$delay"; delay=$(( delay * 2 ))
done

if [ "$FETCH_OK" -ne 1 ]; then
  note
  log "git fetch origin FAILED after 3 attempts (network or auth)."
  log "The origin/* refs in this clone are therefore NOT trustworthy and may be"
  log "arbitrarily stale. Re-run 'git fetch origin' and confirm it succeeds"
  log "before reporting on anything that depends on remote state."
  log "Local HEAD: ${OLD_SHA:0:12} on ${BRANCH:-detached} (committed ${OLD_DATE:-unknown})."
  emit "[session-start git sync] $LOG" "git fetch failed - local clone freshness is UNVERIFIED"
fi

# ------------------------------------------------- default branch context
DEFAULT_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo '')"
if [ -z "$DEFAULT_REF" ]; then
  git remote set-head origin --auto >/dev/null 2>&1
  DEFAULT_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo '')"
fi

days_behind() {
  # $1 = ISO date of older commit. Echoes whole days between it and now.
  local then_s now_s
  then_s="$(date -d "$1" +%s 2>/dev/null)" || return 1
  now_s="$(date +%s)"
  echo $(( (now_s - then_s) / 86400 ))
}

# ---------------------------------------------------------------- detached
if [ -z "$BRANCH" ]; then
  log "Fetched origin OK. HEAD is DETACHED at ${OLD_SHA:0:12} - left exactly as-is"
  log "on purpose (a detached checkout is usually a deliberate revision, e.g. a"
  log "PR review at a specific commit). Nothing was pulled."
  [ -n "$DEFAULT_REF" ] && log "For reference, $DEFAULT_REF is now at $(git rev-parse --short "$DEFAULT_REF" 2>/dev/null)."
  emit "[session-start git sync] $LOG" "Fetched origin; HEAD detached, not moved"
fi

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo '')"

# ------------------------------------------------------------- no upstream
if [ -z "$UPSTREAM" ]; then
  note
  log "Fetched origin OK, but local branch '$BRANCH' has NO upstream configured,"
  log "so nothing could be pulled."
  if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1; then
    behind="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo '?')"
    log "origin/$BRANCH exists and this checkout is $behind commit(s) behind it."
    log "To adopt it: git branch --set-upstream-to=origin/$BRANCH $BRANCH"
  else
    log "There is no origin/$BRANCH either - this looks like a local-only branch."
  fi
  log "Treat local file contents as possibly stale until this is resolved."
  emit "[session-start git sync] $LOG" "Fetched origin; '$BRANCH' has no upstream - not updated"
fi

# ------------------------------------------------------- compare to upstream
counts="$(git rev-list --left-right --count "${UPSTREAM}...HEAD" 2>/dev/null || echo '')"
BEHIND="$(printf '%s' "$counts" | awk '{print $1+0}')"
AHEAD="$(printf '%s' "$counts" | awk '{print $2+0}')"
: "${BEHIND:=0}"; : "${AHEAD:=0}"

DIRTY=0
git diff --quiet --ignore-submodules HEAD 2>/dev/null || DIRTY=1
[ -n "$(git ls-files --others --exclude-standard 2>/dev/null | head -1)" ] && UNTRACKED=1 || UNTRACKED=0

if [ "$BEHIND" -eq 0 ]; then
  log "Fetched origin OK. '$BRANCH' is already up to date with $UPSTREAM at ${OLD_SHA:0:12}."
  [ "$AHEAD" -gt 0 ] && log "(This branch is $AHEAD commit(s) ahead of its upstream - unpushed local work.)"
  emit "[session-start git sync] $LOG" "Up to date with $UPSTREAM"
fi

# Behind. Describe exactly how stale this clone was - this is the number that
# was silently wrong before.
STALE_NOTE=""
if [ -n "$OLD_DATE" ]; then
  d="$(days_behind "$OLD_DATE" 2>/dev/null || echo '')"
  [ -n "$d" ] && STALE_NOTE=" The checked-out commit was ${d} day(s) old."
fi

# Only move the working tree when the session is actually beginning. On
# 'compact'/'clear'/'fork' the agent is mid-task and changing files underneath
# it would be worse than being behind. "unknown-no-jq" lands in the default
# arm on purpose: an unread event type is treated as possibly mid-task.
case "$SOURCE" in
  startup|resume) MAY_ADVANCE=1 ;;
  *)              MAY_ADVANCE=0 ;;
esac

if [ "$AHEAD" -gt 0 ]; then
  note
  log "Fetched origin OK. '$BRANCH' has DIVERGED from $UPSTREAM:"
  log "$BEHIND commit(s) behind, $AHEAD commit(s) ahead.$STALE_NOTE"
  log "Deliberately NOT auto-merging or rebasing - that could lose or reorder the"
  log "local commits. Resolve this before trusting the working tree, and say so"
  log "in any report rather than describing these files as current."
  emit "[session-start git sync] $LOG" "DIVERGED from $UPSTREAM ($BEHIND behind / $AHEAD ahead) - not updated"
fi

if [ "$MAY_ADVANCE" -ne 1 ]; then
  note
  log "Fetched origin OK. '$BRANCH' is $BEHIND commit(s) behind $UPSTREAM.$STALE_NOTE"
  if [ "$HAVE_JQ" -eq 1 ]; then
    log "Not fast-forwarding because this is a '$SOURCE' event, not a session start -"
    log "the files would change underneath work already in progress."
    REASON="not advanced on '$SOURCE'"
  else
    log "Not fast-forwarding because jq is not installed, so the event type could not"
    log "be read from the hook payload. It may well be a 'compact'/'clear'/'fork'"
    log "event mid-task, and moving files underneath work in progress is worse than"
    log "being behind - so this reports instead of advancing. Install jq to get the"
    log "fast-forward on 'startup'/'resume' back."
    REASON="not advanced - jq missing, event type unknown"
  fi
  log "The working tree is $BEHIND commit(s) behind origin; account for that."
  emit "[session-start git sync] $LOG" "$BEHIND commit(s) behind $UPSTREAM ($REASON)"
fi

if [ "$DIRTY" -eq 1 ]; then
  note
  log "Fetched origin OK. '$BRANCH' is $BEHIND commit(s) behind $UPSTREAM.$STALE_NOTE"
  log "NOT fast-forwarding: the working tree has uncommitted changes, and"
  log "discarding or stashing them automatically is not this hook's call."
  log "Commit or stash, then run: git merge --ff-only $UPSTREAM"
  log "Until then the working tree is $BEHIND commit(s) behind origin."
  emit "[session-start git sync] $LOG" "$BEHIND behind $UPSTREAM but tree is dirty - not updated"
fi

# ------------------------------------------------------------ fast-forward
if FF_ERR="$(git merge --ff-only "$UPSTREAM" 2>&1)"; then
  NEW_SHA="$(git rev-parse HEAD 2>/dev/null)"
  log "Fetched origin and FAST-FORWARDED '$BRANCH' $BEHIND commit(s) to match $UPSTREAM."
  log "  before: ${OLD_SHA:0:12} (${OLD_DATE:-unknown})${STALE_NOTE}"
  log "  after:  ${NEW_SHA:0:12} ($(git log -1 --format=%cI HEAD 2>/dev/null))"
  log "The working tree is now current with origin. Files read before this point"
  log "in the session, if any, are out of date."
  if [ "$UNTRACKED" -eq 1 ]; then
    log "(Untracked files are present; they were left untouched.)"
  fi
  SUMMARY="Fast-forwarded $BRANCH $BEHIND commit(s) to $UPSTREAM"
else
  note
  log "Fetched origin OK, but 'git merge --ff-only $UPSTREAM' FAILED while trying to"
  log "advance $BEHIND commit(s):"
  log "$FF_ERR"
  log "The working tree is still $BEHIND commit(s) behind origin - do not describe"
  log "it as current."
  SUMMARY="fast-forward to $UPSTREAM FAILED - still $BEHIND behind"
fi

emit "[session-start git sync] $LOG" "$SUMMARY"
