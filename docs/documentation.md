# Documentation guide

Keep documentation current, concise and useful for decisions.

- Define the intended system in documentation first; implement code that conforms to it.
  Resolve a mismatch by fixing the implementation, or by explicitly changing the requirement
  before implementation. Do not rewrite requirements merely to describe existing code.
- Describe component responsibilities and required behavior, not files, functions or code walkthroughs.
  Code should explain its own implementation. Use code examples or pseudocode only to illustrate an idea.
- Describe the system, not its implementation history. Keep anecdotes, run results, ticket/PR
  references and historical instructions in Git history, not in maintained docs or archives.
- State shared guidance once. Tickets contain the problem and desired outcome, not copied
  policy or an implementation itinerary.
- Describe the intended system without implementation-status notes. Track implementation progress in
  tasks and Git history. Prefer clear principles over detailed prescriptions.
- Keep the reference index in `AGENTS.md` synchronized. Do not repeat document descriptions
  or reference lists elsewhere.
- Keep README to a few sentences for humans, without links. Keep agent guidance in docs.
