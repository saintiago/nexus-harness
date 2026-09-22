# Documentation guide

Keep documentation current, concise and useful for decisions.

- The vision explains purpose and direction; the spec describes current behavior; architecture
  explains responsibilities and design choices; the workflow defines inputs and the operations guide explains usage. Keep README a few sentences for humans, without links. Agent guidance belongs in `AGENTS.md` and `docs/`.
- Update the relevant document when its behavior or guidance changes. Replace stale wording
  rather than appending another revision or exception to it.
- Describe the system, not the story of building it. Keep anecdotes, run results, ticket/PR
  references and historical implementation instructions out of maintained docs. Git history
  retains the past; do not create documentation archives.
- State shared guidance once and link to it. Tickets contain the problem and desired outcome,
  not copies of repository policy or an implementation itinerary.
- Keep planned direction distinct from implemented behavior. Prefer a few clear principles
  over detailed prescriptions. Remove material that no longer helps a reader act or decide.

`AGENTS.md` is the reference guide to all maintained documentation. It contains links and brief
descriptions only; the linked documents contain the guidance itself. Keep this index in sync
when documents are added, renamed or removed.
