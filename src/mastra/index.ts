
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { dockerAgent } from './agents/docker-agent';
import { testDockerWorkflow } from './workflows/test/01-docker-test-workflow';

export const mastra = new Mastra({
  workflows: { testDockerWorkflow },
  agents: { dockerAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
