# YC 24h Hackathon — Mastra Agent Pipeline

A Mastra-powered agentic pipeline that clones a GitHub repository in Docker, gathers repository context, generates unit tests, opens a PR with the tests, and estimates TypeScript + Vitest coverage. Exposes a single HTTP endpoint to trigger the full pipeline.

## Features
- **Docker bootstrap**: Builds a minimal Ubuntu image and starts a container.
- **Secure GitHub cloning**: Uses a host-provided `GITHUB_PAT` written to `.docker.credentials` at runtime.
- **Context gathering**: Parallel analysis of repository structure, codebase, and build/deploy signals; synthesizes an executive summary.
- **Unit test generation (MVP)**: Plans high‑priority targets and generates a Vitest test file, with validation and retry logic.
- **GitHub PR automation**: Creates a branch, commits tests, pushes, and opens a PR; posts the PR URL to a backend.
- **Coverage estimation**: Computes/estimates TS + Vitest coverage algorithmically or via Vitest, and POSTs results to a backend.
- **Telemetry and logging**: Pino logger with env‑controlled verbosity; optional alerts‑only mode.

## Requirements
- Node.js >= 20.9
- Docker (local daemon running)
- A GitHub Personal Access Token (PAT) with repo scope

## Install
```bash
npm install
```

## Environment
Set the following at runtime or in your shell.
- `OPENAI_API_KEY`: for `@ai-sdk/openai` provider used by agents
- `BASE_URL` (optional): backend base URL for posting description/stack/PR URL/coverage (default `http://localhost:3000`)
- `MASTRA_LOG_LEVEL` (optional): one of `fatal|error|warn|info|debug|trace|silent` (default `debug`)
- `LOG_MODE` or `MASTRA_LOG_MODE` (optional): set `alerts_only` to suppress logs except step alerts

The pipeline endpoint requires a GitHub token, provided either as:
- Bearer token in `Authorization: Bearer <GITHUB_PAT>` header, or
- One of body fields: `token`, `githubToken`, `github_access_token`, `GITHUB_PAT`

## Run (dev server)
```bash
npm run dev
```
By default Mastra serves on `http://localhost:4111`. Built‑in routes are under `/api`. This project also registers a custom route described below.

## API
- POST `/start-full-pipeline` (custom route)
  - Headers (option 1): `Authorization: Bearer <GITHUB_PAT>`
  - Body (JSON):
    - `projectId` (string, required): ID to associate all step alerts/results
    - `contextData` (object, optional): freeform context saved into the container as `/app/agent.context.json`
    - `repositoryUrl` (string, optional): `owner/repo` or `https://github.com/owner/repo[.git]` (fallbacks to context heuristics)
  - Response: `{ message, runId }` and the workflow runs asynchronously.

Example:
```bash
curl -X POST http://localhost:4111/start-full-pipeline \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -d '{
        "projectId": "your-project-id",
        "repositoryUrl": "owner/repo",
        "contextData": { "note": "seeded context" }
      }'
```

## What the pipeline does
Entry file: `src/mastra/index.ts` registers workflows and the `/start-full-pipeline` route.

Workflow: `full-pipeline-workflow`
1) Docker setup and GitHub clone
   - Builds minimal Ubuntu image, runs container, clones the target repo via `.docker.credentials`.
2) Post project info (parallel)
   - Posts synthesized description and detected tech stack to `POST ${BASE_URL}/api/projects/:projectId/...`.
3) Save context
   - Writes `agent.context.json` into the container.
4) Gather context (parallel scan)
   - Quick repository, codebase, and build/deploy analyses; synthesizes an executive summary.
5) Unit test generation (MVP)
   - Plans high‑priority target; generates a Vitest test file with verification and retry logic.
6) GitHub PR
   - Creates branch, commits tests, pushes, opens PR, posts PR URL to backend.
7) Coverage
   - Estimates or runs Vitest coverage; POSTs structured stats to backend.

Key files to explore:
- `src/mastra/index.ts`: Mastra setup, server route for `/start-full-pipeline`.
- `src/mastra/workflows/full-pipeline-workflow.ts`: Orchestration of the end‑to‑end steps.
- `src/mastra/workflows/test/01-docker-test-workflow.ts`: Docker build/run, GitHub clone, description/stack posting, context save.
- `src/mastra/workflows/test/02-gather-context-workflow.ts`: Parallel repo/codebase/build analyses and synthesis.
- `src/mastra/workflows/test/03-generate-unit-tests-workflow.ts`: MVP planning, test generation, validation/retry, finalize.
- `src/mastra/workflows/test/04-github-pr-workflow.ts`: Branch, commit, push, open PR, post PR URL.
- `src/mastra/workflows/test/05-test-coverage-workflow.ts`: Coverage calculation and backend POST.

## Notes & tips
- The server writes `.docker.credentials` to the project root (and a fallback `../../.docker.credentials`) containing `GITHUB_PAT=<token>`; it’s copied into the container for cloning and then removed from the container.
- If `repositoryUrl` isn’t provided, the clone step infers `owner/repo` from `contextData` or defaults to this repo.
- Alerts and step statuses are sent via `notifyStepStatus` to a backend at `${BASE_URL}/api/alerts` (see `tools/alert-notifier.ts`).
- Storage defaults to in‑memory `LibSQLStore`; change if persistence is needed.

## Production
```bash
npm run build
npm run start
```
`mastra start` runs the bundled Hono server from `.mastra/output`.

## Troubleshooting
- "Docker not found": ensure Docker is installed and the daemon is running.
- "Missing GitHub token": supply a Bearer token or a recognized body field.
- "Repo clone failed": verify `repositoryUrl` format and PAT scopes.
- "PR creation failed (422: No commits)": the workflow attempts recovery by creating/pushing a commit before retrying.
- Coverage on minimal containers may fall back to algorithmic estimation if Node/Vitest aren’t available.
