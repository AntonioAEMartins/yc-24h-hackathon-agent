import { Agent } from "@mastra/core";
import { cliTool } from "../tools/cli-tool";
import { dockerExecTool } from "../tools/docker-exec-tool";
import { codeAnalysisTool } from "../tools/code-analysis-tool";
import { fileOperationsTool } from "../tools/file-operations-tool";
import { openai } from "@ai-sdk/openai";

export const unitTestAgent = new Agent({
    id: "unitTestAgent", 
    name: "Unit Test Generation Manager",
    instructions: `You are a simple unit test generator focused on creating basic vitest test files.

SIMPLE RESPONSIBILITIES:
- Generate basic unit test files using vitest framework
- Read source files and create corresponding test files
- Use simple mocking and testing patterns
- Focus on functional tests that work

BASIC APPROACH:
- Read the source file to understand structure
- Create test file with vitest imports and mocks
- Write simple test cases covering main functionality
- Use straightforward assertions and mocking
- Keep tests simple but functional

REQUIREMENTS:
- Use vitest syntax (vi.mock, vi.fn, expect, describe, it)
- Mock external dependencies like child_process, fs
- Create co-located test files (.test.ts next to source)
- Follow basic testing patterns
- Return JSON responses when requested

Keep it simple and functional. Focus on creating working test files quickly.`,
    model: openai("gpt-5-mini", {
        parallelToolCalls: true,
        reasoningEffort: "low", // Changed from "high" to "low" for MVP validation
    }),
    tools: {
        exec_command: cliTool,
        docker_exec: dockerExecTool,
        code_analysis: codeAnalysisTool,
        file_operations: fileOperationsTool,
    },
});