
import { Mastra } from '@mastra/core/mastra';
import { registerApiRoute } from '@mastra/core/server';
import { PinoLogger } from '@mastra/loggers';
import type { LogLevel } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { dockerAgent } from './agents/docker-agent';
import { contextAgent } from './agents/context-agent';
import { unitTestAgent } from './agents/unit-test-agent';
import { testAnalysisAgent } from './agents/test-analysis-agent';
import { testSpecificationAgent } from './agents/test-specification-agent';
import { testGenerationAgent } from './agents/test-generation-agent';
import { testValidationAgent } from './agents/test-validation-agent';
import { githubPrAgent } from './agents/github-pr-agent';
import { codebaseDescriptionAgent } from './agents/codebase-description-agent';
import { testCoveringAgent } from './agents/test-covering-agent';
import { typescriptVitestCoverageAgent } from './agents/typescript-vitest-coverage-agent';
// import { testManagerAgent } from './agents/test-manager-agent'; // COMMENTED OUT FOR MVP VALIDATION
// import { testCoderAgent } from './agents/test-coder-agent'; // COMMENTED OUT FOR MVP VALIDATION
import { testDockerWorkflow } from './workflows/test/01-docker-test-workflow';
import { gatherContextWorkflow } from './workflows/test/02-gather-context-workflow';
import { generateUnitTestsWorkflow } from './workflows/test/03-generate-unit-tests-workflow';
import { githubPrWorkflow } from './workflows/test/04-github-pr-workflow';
import { testCoverageWorkflow } from './workflows/test/05-test-coverage-workflow';
// import { unitTestWorkflow } from './workflows/unit-test-workflow';
import { fullPipelineWorkflow } from './workflows/full-pipeline-workflow';
import { writeFileSync } from 'fs';
import path from 'path';
import { associateRunWithProject } from './tools/alert-notifier';

// Runtime log/telemetry controls
const LOG_MODE = process.env.LOG_MODE || process.env.MASTRA_LOG_MODE || (process.env.ALERTS_ONLY === 'true' ? 'alerts_only' : 'default');
const ALERTS_ONLY = LOG_MODE === 'alerts_only';

const allowedLevels = ['fatal','error','warn','info','debug','trace','silent'] as const;
const getLogLevel = (): LogLevel => {
  if (ALERTS_ONLY) return 'silent' as LogLevel;
  const envRaw = process.env.MASTRA_LOG_LEVEL;
  const level = (allowedLevels as readonly string[]).includes(envRaw || '') ? (envRaw as LogLevel) : ('debug' as LogLevel);
  return level;
};

export const mastra = new Mastra({
  workflows: { testDockerWorkflow, gatherContextWorkflow, generateUnitTestsWorkflow, githubPrWorkflow, testCoverageWorkflow, fullPipelineWorkflow },
  agents: { 
    dockerAgent, 
    contextAgent, 
    unitTestAgent,
    testAnalysisAgent,
    testSpecificationAgent, 
    testGenerationAgent,
    testValidationAgent,
    githubPrAgent,
    codebaseDescriptionAgent,
    testCoveringAgent,
    typescriptVitestCoverageAgent,
    // testManagerAgent, // COMMENTED OUT FOR MVP VALIDATION
    // testCoderAgent    // COMMENTED OUT FOR MVP VALIDATION
  },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  server: {
    apiRoutes: [
      registerApiRoute('/start-full-pipeline', {
        method: 'POST',
        handler: async (c) => {
          try {
            const body = await c.req.json().catch(() => ({}));
            const authHeader = c.req.header('authorization') || c.req.header('Authorization');
            const headerToken = authHeader && authHeader.startsWith('Bearer ')
              ? authHeader.slice(7).trim()
              : undefined;
            const githubAccessToken = headerToken || body.token || body.githubToken || body.github_access_token || body.GITHUB_PAT;
            const contextData = body.contextData ?? body;
            const projectId: string = body.projectId || body.projectID || body.project_id;

            if (!githubAccessToken || typeof githubAccessToken !== 'string') {
              return c.json({ error: 'Missing required GitHub access token in body (token | githubToken | github_access_token | GITHUB_PAT)' }, 400);
            }

            if (!projectId || typeof projectId !== 'string') {
              return c.json({ error: 'Missing required projectId in body (projectId | projectID | project_id)' }, 400);
            }

            const credentialsContent = `GITHUB_PAT=${githubAccessToken}\n`;

            const cwd = process.cwd();
            const primaryPath = path.resolve(cwd, '.docker.credentials');
            const fallbackPath = path.resolve(cwd, '..', '..', '.docker.credentials');

            try { writeFileSync(primaryPath, credentialsContent, 'utf8'); } catch {}
            try { writeFileSync(fallbackPath, credentialsContent, 'utf8'); } catch {}

            const workflow = (c.get('mastra') as typeof mastra).getWorkflow('fullPipelineWorkflow');
            const run = await workflow.createRunAsync();

            // Associate run with project (projectId is now required and validated above)
            associateRunWithProject(run.runId, projectId);

            // Fire-and-forget with visible logging
            setImmediate(() => {
              try {
                console.log(`[start-full-pipeline] Starting run ${run.runId}`);
                run.start({ inputData: { contextData, projectId } })
                  .then((result: any) => {
                    console.log(`[start-full-pipeline] Run ${run.runId} completed with status: ${result.status}`);
                  })
                  .catch((err: any) => {
                    console.error(`[start-full-pipeline] Run ${run.runId} failed:`, err);
                  });
              } catch (err) {
                console.error(`[start-full-pipeline] Failed to schedule run ${run.runId}:`, err);
              }
            });

            return c.json({ message: 'fullPipelineWorkflow started', runId: run.runId });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return c.json({ error: message }, 500);
          }
        }
      })
    ]
  },
  logger: new PinoLogger({
    name: 'Mastra',
    // Set to 'silent' when running in alerts-only mode to suppress all logs except notifyStepStatus
    level: getLogLevel(),
  }),
  telemetry: {
    serviceName: 'yc-24h-hackathon-agent',
    // Disable telemetry entirely when alerts-only mode is enabled
    enabled: !ALERTS_ONLY,
    sampling: {
      type: 'always_on', // Capture all traces for development
    },
    export: {
      type: 'console', // Console output for development
    },
  },
});
