# Contributing to CollabWrite

First off, thank you for considering contributing to **CollabWrite**! We welcome contributions from developers, educators, researchers, and students interested in distributed systems, real-time collaboration, Operating Systems concurrency, and Database Management Systems.

---

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please report any unacceptable behavior to `security@collabwrite.dev`.

---

## How Can I Contribute?

1. **Reporting Bugs**: File detailed issues using the Bug Report template.
2. **Suggesting Enhancements**: Submit feature requests with clear use cases and architectural rationale.
3. **Algorithm Improvements**: Improve the engine's algorithms - page replacement, lock scheduling, deadlock detection, B+-Tree balancing or recovery.
4. **Documentation**: Improve guides, fix typos, add interactive architecture diagrams, or expand educational OS/DBMS explanations.
5. **Writing Tests**: Add edge cases to the B+-Tree property test, stress concurrent transactions, or extend the crash-recovery scenarios.

---

## Development Setup

### Prerequisites
- **Node.js**: `v22.x` or newer (CI runs v26)
- **PostgreSQL**: `v14+` (optional - set `STORE_DRIVER=memory` to run without it)
- **Docker & Docker Compose**: Recommended for local environment setup

### Local Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/purvanshjoshi/CollabWrite.git
   cd CollabWrite
   ```

2. **Setup Environment Variables:**
   ```bash
   cp .env.example .env
   ```

3. **Start PostgreSQL via Docker** (skip if using `STORE_DRIVER=memory`)**:**
   ```bash
   docker compose up -d postgres
   ```

4. **Initialize Database Schema:**
   ```bash
   # Connect to postgres container and run schema init
   docker exec -i collabwrite_postgres psql -U collabuser -d collabwrite < database/init.sql
   docker exec -i collabwrite_postgres psql -U collabuser -d collabwrite < database/seeds/001_sample_data.sql
   ```

5. **Install Backend & Frontend Dependencies:**
   ```bash
   npm install
   ```

6. **Run the Development Server:**
   ```bash
   npm run dev
   ```

---

## Git Workflow & Branching Strategy

We follow the **Git Flow / GitHub Flow** model:

- `main`: Production-ready, stable releases only.
- `develop`: Primary integration branch for new features.
- Feature branches: `feat/feature-name`
- Bugfix branches: `fix/issue-description`
- Performance/Refactor: `refactor/optimization-scope`
- Documentation: `docs/topic-name`

---

## Commit Message Conventions

We adhere strictly to [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

### Allowed Types:
- `feat`: A new feature (e.g., `feat(index): add range scan to the B+-Tree`)
- `fix`: A bug fix (e.g., `fix(locks): resolve deadlock when releasing expired write locks`)
- `docs`: Documentation changes only (e.g., `docs(readme): update deployment guide`)
- `style`: Formatting, missing semicolons, whitespace (no code change)
- `refactor`: Code restructuring without bug fix or new feature
- `perf`: Performance enhancement (e.g., `perf(query): add composite index for active user sessions`)
- `test`: Adding missing tests or refactoring test suites
- `chore`: Build process, dependencies, tooling updates

---

## Testing Guidelines

Before opening a Pull Request, make sure all tests pass:

```bash
# Run unit tests
npm test

# Run with the coverage gate (80% over src/engine)
npm run test:coverage

# Per-module subsets
npm run test:storage      # Phases 3-4: pages, storage, buffer pool
npm run test:transactions # Phase 5
npm run test:locks        # Phase 6: locking and deadlock detection
npm run test:scheduler    # Phases 7-8: scheduling and messaging
npm run test:index        # Phase 10: B+-Tree property tests
npm run test:recovery     # Phase 11: WAL and crash recovery

# The evaluation demos: each asserts its own outcome
npm run demo

# Run linter
npm run lint
```

---

## Pull Request Process

1. Fork the repo and create your branch from `develop` (or `main` if hotfix).
2. Ensure new code has accompanying unit/integration tests with high coverage.
3. Update relevant documentation in `docs/` if modifying APIs, algorithms, or schemas.
4. Ensure your code passes all lint and formatting checks (`npm run lint`).
5. Open a Pull Request referencing the corresponding issue (e.g., `Fixes #42`).
6. PRs require review and approval from at least one core maintainer before merging.

Thank you for building the future of open-source collaborative systems with CollabWrite!
