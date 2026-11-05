# Contributing to Speedy

Thanks for taking a look. This project is small on purpose — one Node process, one SQLite file, no
build step — and the rules below exist to keep it that way.

## How changes reach `main`

`main` is the released branch. Nobody pushes to it directly.

- **Outside contributors** — fork the repository, work on a branch in your fork, and open a pull
  request against `main`. You do not need write access and you never touch this repository.
- **Collaborators** (people the maintainer has invited) — push a branch to this repository and open a
  pull request from it. Same review, shorter loop.
- **Maintainer** — merges pull requests. Administrators can bypass branch protection for an emergency
  fix, but that is the exception, not the workflow.

Every pull request needs a green CI run (tests on Node 22 and 24, dependency audit, secret scan) before
it can be merged.

## Getting set up

```bash
git clone https://github.com/<your-fork>/Speedy.git
cd Speedy
npm install
node scripts/setup.js      # writes .env with generated secrets
npm run seed               # optional: demo users and conversations
npm run dev                # http://localhost:3000
```

Node 22 or newer. There is no build step — the frontend is served as plain ES modules.

## Before you open a pull request

1. **Run the tests.** `npm test` must pass. Add a test for anything behavioural; the suite is the
   contract, and a fix without a test is a fix that will regress.
2. **Keep it focused.** One concern per pull request. A dependency bump and a refactor in the same
   branch is two pull requests.
3. **Match the code style.** ES modules, no semicolon-free cleverness, 2-space indent, single quotes,
   `const` by default. Comments explain *why*, not *what*.
4. **Do not commit secrets.** `.env`, `data/` and anything containing a key are git-ignored; CI fails
   the build if it spots a `JWT_SECRET=` or `MESSAGE_KEY=` pattern.
5. **Security-sensitive changes** (auth, crypto, uploads, CSP) get a longer look. Say what you changed
   and why in the description, and add a note to `docs/SECURITY.md` if the threat model moves.

## Commit messages

Conventional Commits, because the history is read more often than it is written:

```
feat(chat): add disappearing messages
fix(auth): reject reuse of a rotated refresh token
docs: document the backup restore path
chore(deps): bump express to 5.3.0
```

The scope is optional but useful: `auth`, `chat`, `ui`, `deps`, `docs`, `security`.

## What is likely to be accepted

- Bug fixes with a reproduction and a test.
- Accessibility fixes, mobile layout fixes, performance work with a measurement.
- Documentation corrections — genuinely valuable here.
- New features **after an issue has been discussed**, so effort is not wasted.

## What is likely to be rejected

- End-to-end encryption "in a small patch". E2EE is a designed change (key directory, device trust,
  ratchets, group keys) and it removes server-side search and previews. Open an issue first.
- Rewrites in a different framework, TypeScript migration, or a build pipeline — the no-build choice is
  deliberate.
- Dependency additions for things the standard library already does.
- Formatting-only pull requests that touch the whole tree.

## Licensing

Speedy is Apache-2.0. By opening a pull request you agree your contribution is licensed under the same
terms (inbound = outbound). No CLA is required. If your employer holds rights to your work, make sure
you have permission before contributing.

## Reporting a security issue

Do **not** open a public issue. Use GitHub's private vulnerability reporting on the Security tab, or
email the maintainer. See [.github/SECURITY.md](.github/SECURITY.md).

## Code of conduct

Be decent. Disagreement about code is welcome and expected; dismissiveness about people is not.
Maintainers may close pull requests or issues that ignore this.
