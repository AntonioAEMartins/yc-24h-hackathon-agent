
import { Mastra } from '@mastra/core/mastra';
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
// import { testManagerAgent } from './agents/test-manager-agent'; // COMMENTED OUT FOR MVP VALIDATION
// import { testCoderAgent } from './agents/test-coder-agent'; // COMMENTED OUT FOR MVP VALIDATION
import { testDockerWorkflow } from './workflows/test/01-docker-test-workflow';
import { gatherContextWorkflow } from './workflows/test/02-gather-context-workflow';
import { generateUnitTestsWorkflow } from './workflows/test/03-generate-unit-tests-workflow';
// import { unitTestWorkflow } from './workflows/unit-test-workflow';
import { fullPipelineWorkflow } from './workflows/full-pipeline-workflow';

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
  workflows: { testDockerWorkflow, gatherContextWorkflow, generateUnitTestsWorkflow, fullPipelineWorkflow },
  agents: { 
    dockerAgent, 
    contextAgent, 
    unitTestAgent,
    testAnalysisAgent,
    testSpecificationAgent, 
    testGenerationAgent,
    testValidationAgent,
    // testManagerAgent, // COMMENTED OUT FOR MVP VALIDATION
    // testCoderAgent    // COMMENTED OUT FOR MVP VALIDATION
  },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  // logger: new PinoLogger({
  //   name: 'Mastra',
  //   // Set to 'silent' when running in alerts-only mode to suppress all logs except notifyStepStatus
  //   level: getLogLevel(),
  // }),
  // telemetry: {
  //   serviceName: 'yc-24h-hackathon-agent',
  //   // Disable telemetry entirely when alerts-only mode is enabled
  //   enabled: !ALERTS_ONLY,
  //   sampling: {
  //     type: 'always_on', // Capture all traces for development
  //   },
  //   export: {
  //     type: 'console', // Console output for development
  //   },
  // },
});
