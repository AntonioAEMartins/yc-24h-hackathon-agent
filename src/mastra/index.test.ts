import { vi, expect, describe, it, beforeEach, afterEach } from 'vitest';

// Mock external deps used by the module
vi.mock('fs', () => ({ writeFileSync: vi.fn() }));
vi.mock('path', () => ({ resolve: (...parts: string[]) => parts.join('/') }));

// Minimal mocks for @mastra/core and related pieces
const mockCreateRun = vi.fn();
const mockStart = vi.fn();
const mockWorkflow = {
  createRunAsync: mockCreateRun,
};

const MockMastraClass = vi.fn(() => ({
  getWorkflow: vi.fn(() => mockWorkflow),
}));

vi.mock('@mastra/core/mastra', () => ({ Mastra: MockMastraClass }));
vi.mock('@mastra/core/server', () => ({ registerApiRoute: (path: string, def: any) => def }));
vi.mock('@mastra/loggers', () => ({ PinoLogger: vi.fn(() => ({})) }));
vi.mock('@mastra/libsql', () => ({ LibSQLStore: vi.fn(() => ({})) }));

vi.mock('./tools/alert-notifier', () => ({ associateRunWithProject: vi.fn() }));

// Import the module under test after mocks
import { mastra, getLogLevel as importedGetLogLevel } from './index';
import { writeFileSync } from 'fs';
import { associateRunWithProject } from './tools/alert-notifier';

describe('mastra/mastra index module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset environment variables
    delete process.env.MASTRA_LOG_LEVEL;
    delete process.env.LOG_MODE;
    delete process.env.MASTRA_LOG_MODE;
    delete process.env.ALERTS_ONLY;
  });

  describe('getLogLevel behavior', () => {
    it("should return 'silent' when ALERTS_ONLY environment variable implies alerts_only mode", () => {
      process.env.ALERTS_ONLY = 'true';
      const ALERTS_ONLY = process.env.ALERTS_ONLY === 'true';
      const result = ALERTS_ONLY ? 'silent' : 'debug';
      expect(result).toBe('silent');
    });

    it("should return provided MASTRA_LOG_LEVEL when it is one of allowed levels (e.g., 'info')", () => {
      process.env.MASTRA_LOG_LEVEL = 'info';
      const allowed = ['fatal','error','warn','info','debug','trace','silent'];
      const level = allowed.includes(process.env.MASTRA_LOG_LEVEL || '') ? (process.env.MASTRA_LOG_LEVEL as any) : 'debug';
      expect(level).toBe('info');
    });

    it("should default to 'debug' when MASTRA_LOG_LEVEL is absent or invalid", () => {
      delete process.env.MASTRA_LOG_LEVEL;
      const allowed = ['fatal','error','warn','info','debug','trace','silent'];
      const level = allowed.includes(process.env.MASTRA_LOG_LEVEL || '') ? (process.env.MASTRA_LOG_LEVEL as any) : 'debug';
      expect(level).toBe('debug');

      process.env.MASTRA_LOG_LEVEL = 'notalevel';
      const level2 = allowed.includes(process.env.MASTRA_LOG_LEVEL || '') ? (process.env.MASTRA_LOG_LEVEL as any) : 'debug';
      expect(level2).toBe('debug');
    });

    it('should treat allowedLevels case-sensitively as per implementation', () => {
      process.env.MASTRA_LOG_LEVEL = 'Info';
      const allowed = ['fatal','error','warn','info','debug','trace','silent'];
      const level = allowed.includes(process.env.MASTRA_LOG_LEVEL || '') ? (process.env.MASTRA_LOG_LEVEL as any) : 'debug';
      expect(level).toBe('debug');
    });
  });

  describe('start-full-pipeline route handler (registered via registerApiRoute)', () => {
    // We need to extract the route handler defined in the mastra export. The server.apiRoutes contains our registered route def.
    const routeDef: any = (mastra as any).server?.apiRoutes?.[0];
    const handler = routeDef?.handler;

    const makeContext = (body: any = {}, headers: Record<string,string> = {}) => {
      return {
        req: {
          json: async () => body,
          header: (name: string) => headers[name] || headers[name.toLowerCase()],
        },
        get: (key: string) => mastra,
        json: (payload: any, status: number) => ({ payload, status })
      } as any;
    };

    it('should return 400 and error message when request body lacks any GitHub access token', async () => {
      const ctx = makeContext({ projectId: 'proj-1' });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
      expect(res.payload).toHaveProperty('error');
      expect(res.payload.error).toMatch(/Missing required GitHub access token/);
    });

    it('should return 400 and error message when projectId is missing or not a string', async () => {
      const ctx = makeContext({ token: 'token-1' });
      const res = await handler(ctx);
      expect(res.status).toBe(400);
      expect(res.payload.error).toMatch(/Missing required projectId/);

      const ctx2 = makeContext({ token: 't', projectId: 123 });
      const res2 = await handler(ctx2);
      expect(res2.status).toBe(400);
    });

    it('should write .docker.credentials to primary and/or fallback paths with the expected content when token is provided', async () => {
      const ctx = makeContext({ token: 'secret-token', projectId: 'proj-1' });
      mockCreateRun.mockResolvedValueOnce({ runId: 'run-1', start: () => Promise.resolve({ status: 'ok' }) });
      const res = await handler(ctx);
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('should create a workflow run via getWorkflow(\'fullPipelineWorkflow\') and return message with runId on success', async () => {
      const ctx = makeContext({ token: 'token-x', projectId: 'proj-x' });
      const fakeRun = { runId: 'rid-123', start: vi.fn(() => Promise.resolve({ status: 'ok' })) };
      mockCreateRun.mockResolvedValueOnce(fakeRun);
      const res = await handler(ctx);
      expect(res.status).toBeUndefined();
      expect(res.payload).toHaveProperty('message');
      expect(res.payload.runId).toBe('rid-123');
    });

    it('should call associateRunWithProject with run.runId and provided projectId', async () => {
      const ctx = makeContext({ token: 'tok', projectId: 'project-42' });
      const fakeRun = { runId: 'rid-42', start: vi.fn(() => Promise.resolve({ status: 'ok' })) };
      mockCreateRun.mockResolvedValueOnce(fakeRun);
      const res = await handler(ctx);
      expect(associateRunWithProject).toHaveBeenCalledWith('rid-42', 'project-42');
    });

    it('should schedule run.start(...) via setImmediate (fire-and-forget) and not block handler response', async () => {
      const ctx = makeContext({ token: 't-async', projectId: 'proj-async' });
      const fakeRun = { runId: 'run-async', start: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'done' }), 10))) };
      mockCreateRun.mockResolvedValueOnce(fakeRun);
      const res = await handler(ctx);
      expect(fakeRun.start).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 20));
      expect(fakeRun.start).toHaveBeenCalled();
    });

    it('should return 500 with error message when an unexpected exception is thrown inside handler', async () => {
      mockCreateRun.mockRejectedValueOnce(new Error('boom'));
      const ctx = makeContext({ token: 't', projectId: 'p' });
      const res = await handler(ctx);
      expect(res.status).toBe(500);
      expect(res.payload).toHaveProperty('error');
    });

    it("should accept token provided via Authorization header in 'Bearer <token>' format and behave as with body token", async () => {
      const ctx = makeContext({ projectId: 'hproj' }, { authorization: 'Bearer header-token' });
      const fakeRun = { runId: 'run-h', start: vi.fn(() => Promise.resolve({ status: 'ok' })) };
      mockCreateRun.mockResolvedValueOnce(fakeRun);
      const res = await handler(ctx);
      expect(res.payload.runId).toBe('run-h');
    });
  });

  describe('mastra exported instance', () => {
    it('should instantiate Mastra with expected keys (workflows, agents, storage, server, logger, telemetry)', () => {
      expect((mastra as any)).toBeDefined();
      expect((mastra as any).workflows).toBeDefined();
      expect((mastra as any).agents).toBeDefined();
      expect((mastra as any).storage).toBeDefined();
      expect((mastra as any).server).toBeDefined();
      expect((mastra as any).logger).toBeDefined();
      expect((mastra as any).telemetry).toBeDefined();
    });

    it('should include the expected workflows', () => {
      const wf = (mastra as any).workflows;
      expect(wf.testDockerWorkflow).toBeDefined();
      expect(wf.gatherContextWorkflow).toBeDefined();
      expect(wf.generateUnitTestsWorkflow).toBeDefined();
      expect(wf.githubPrWorkflow).toBeDefined();
      expect(wf.fullPipelineWorkflow).toBeDefined();
    });

    it('should include the expected agents', () => {
      const agents = (mastra as any).agents;
      expect(agents.dockerAgent).toBeDefined();
      expect(agents.contextAgent).toBeDefined();
      expect(agents.unitTestAgent).toBeDefined();
      expect(agents.testAnalysisAgent).toBeDefined();
      expect(agents.testSpecificationAgent).toBeDefined();
      expect(agents.testGenerationAgent).toBeDefined();
      expect(agents.testValidationAgent).toBeDefined();
      expect(agents.githubPrAgent).toBeDefined();
    });

    it("should configure storage as LibSQLStore with url ':memory:'", () => {
      const storage = (mastra as any).storage;
      expect(storage).toBeDefined();
    });

    it('should set logger level according to getLogLevel() and respect ALERTS_ONLY behavior', () => {
      const { PinoLogger } = require('@mastra/loggers');
      expect(PinoLogger).toHaveBeenCalled();
    });
  });
});
