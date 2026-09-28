# Personal context

Files in this directory are automatically read and prepended to every **new** OpenCode session the daemon
starts (not re-sent on task continuations, since the context is already in that session's history). This is
what stops the agent from guessing or hallucinating your details, preferences, or where your files live.

Never committed to git (see `.gitignore`) — this is personal data, not project source.

Suggested files (create whichever you actually need; none are required):

- `profile.md` — who you are, what you do, how you like things communicated
- `career.md` — resume summary, target roles, comp/location constraints, companies to avoid
- `files.md` — local paths to things the agent may need to reference or upload, e.g.:
  ```
  Resume (PDF): C:\Users\ishgu\Documents\resume.pdf
  Cover letter template: C:\Users\ishgu\Documents\cover-letter-base.md
  ```
- `preferences.md` — anything else: writing tone, accounts/emails to use for which site, things to always ask before doing

Keep these short and factual. This gets read on every new session, so bloated files cost tokens on every task.
