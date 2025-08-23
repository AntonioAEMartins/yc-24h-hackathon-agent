
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { dockerAgent } from './agents/docker-agent';
import { contextAgent } from './agents/context-agent';
import { testDockerWorkflow } from './workflows/test/01-docker-test-workflow';
import { gatherContextWorkflow } from './workflows/test/02-gather-context-workflow';

export const mastra = new Mastra({
  workflows: { testDockerWorkflow, gatherContextWorkflow },
  agents: { dockerAgent, contextAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'debug', // Changed to debug for more detailed logging
  }),
  telemetry: {
    serviceName: 'yc-24h-hackathon-agent',
    enabled: true,
    sampling: {
      type: 'always_on', // Capture all traces for development
    },
    export: {
      type: 'console', // Console output for development
    },
  },
});
