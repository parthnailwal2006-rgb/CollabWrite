# Project Development Rules (rules.md)

## 1. Core Development Philosophy
The assistant (and the team) must **prioritize understanding and implementing operating‑system (OS) and database‑management‑system (DBMS) concepts** over adding superficial UI features. Every new feature should be justified by an academic objective before UI polish.

## 2. No Blind API Implementation
Do **not** satisfy an academic requirement by merely invoking an existing library and claiming it as our own implementation. Examples of prohibited shortcuts:
- Declaring PostgreSQL transactions as our "Transaction Manager".
- Using PostgreSQL row‑level locks as the "Lock Manager".
- Treating a JavaScript `setTimeout`/event loop as a scheduler.
- Relying on Socket.IO’s built‑in message routing as our "Message‑Passing" layer.
- Using a built‑in B‑Tree index from PostgreSQL as our "Index Manager".

If such an API is needed for supporting data (e.g., user authentication), explicitly label it as **PostgreSQL support** in the documentation.

## 3. Manual Implementation Rule
Whenever an academic mechanism is required, the assistant must follow a **six‑step explanation** before any code is written:
1. **Concept** – brief theory and why it matters.
2. **Data Structures** – what structures will represent the concept.
3. **Algorithm** – the steps the implementation will follow.
4. **Implementation** – plan the concrete module and its API.
5. **Test** – design unit/integration tests that verify the behavior.
6. **Result** – expected outcome and how the demo will show it.

Only after this explanation may the assistant proceed to code.

## 4. No Premature Coding
Before implementing any module, the assistant must first explain:
- The purpose of the module.
- The OS/DBMS concept it demonstrates.
- Input and output specifications.
- Data structures used internally.
- The testing strategy.

This ensures the team understands the design before diving into code.

## 5. One Phase at a Time
Implementation must strictly follow the **phases** described in `phases.md`. A later phase cannot start until the preceding phase is **completed, tested, and approved**.

## 6. Student Learning Rule
We are students; the assistant must never hide critical logic behind an opaque library call. Code should be:
- Small and focused.
- Well‑named variables and functions.
- Richly commented with algorithmic explanations.
- Accompanied by step‑by‑step walkthroughs.

## 7. Architecture Consistency Rule
Any new feature or module must conform to the architecture defined in `architecture.md`. If a change is required, update the architecture document first and obtain approval.

## 8. Database Rule
PostgreSQL is allowed **only** for:
- User account storage.
- Authentication metadata (hashed passwords, JWT secret references).
- Administrative audit logs.
All collaborative‑document data, versioning, locking, indexing, and recovery must be handled by our own educational engine.

## 9. OS Rule
Framework features are **not** substitutes for OS concepts. For example:
- A request queue is **not** automatically a scheduler; we must implement explicit scheduling policies.
- JavaScript callbacks are not processes; we must model workers/threads.
- Library‑provided mutexes are not our own lock manager; we must build a lock table and compatibility logic.

## 10. Testing Rule
Every academic module must have **automated tests** covering:
- Unit tests for core data structures.
- Integration tests that involve multiple modules (e.g., transaction + lock + recovery).
- Controlled demonstrations (scripts) that can be run during the evaluation demo.

## 11. Documentation Rule
Documentation must be updated whenever:
- A module is completed.
- An architectural decision changes.
- A requirement is added, removed, or altered.
- A bug reveals a design flaw.
- A new academic concept is introduced.

## 12. Security Rule
- Store passwords only as strong salted hashes (e.g., bcrypt).
- Use HTTPS for all client‑server traffic.
- Validate JWTs on every request.
- Do not expose internal engine state or raw WAL files to unauthenticated users.

## 13. Scope Control Rule
If a requested feature does **not** contribute to the core academic objectives, the assistant must request clarification and provide a justification before adding it. Unjustified scope creep is prohibited.

---
*End of rules.md*
