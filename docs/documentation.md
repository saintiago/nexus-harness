# Documentation guide

Keep documentation current, concise and useful for decisions.

- Define the intended system in documentation first; implement code that conforms to it.
  Resolve a mismatch by fixing the implementation, or by explicitly changing the requirement
  before implementation. Do not rewrite requirements merely to describe existing code.
- Describe component responsibilities and required behavior, not files, functions or code walkthroughs.
  Code should explain its own implementation. Use code examples or pseudocode only to illustrate an idea.
- Keep repository contents limited to current documentation, implementation, configuration and tests.
  Keep task inventories, activity journals, run results, agent transcripts and other development
  bookkeeping in the task tracker or pull request, not in repository files or archives. Test fixtures
  must be consumed by tests. Git history retains past versions and decisions.
- State shared guidance once. Tickets contain the problem and desired outcome, not copied
  policy or an implementation itinerary.
- Describe the intended system without implementation-status notes. Track implementation progress in
  the task tracker. Prefer clear principles over detailed prescriptions.
- Keep the reference index in `AGENTS.md` synchronized. Do not repeat document descriptions
  or reference lists elsewhere.
- Keep README to a few sentences for humans, without links. Keep agent guidance in docs.
