import { Agent } from "@mastra/core";
import { dockerExecTool } from "../tools/docker-exec-tool";
import { fileOperationsTool } from "../tools/file-operations-tool";
import { coverageDetectionTool } from "../tools/coverage-detection-tool";
import { coverageRunnerTool } from "../tools/coverage-runner-tool";
import { coverageParseTool } from "../tools/coverage-parse-tool";
import { cliTool } from "../tools/cli-tool";
import { openai } from "@ai-sdk/openai";

export const testCoveringAgent = new Agent({
    id: "testCoveringAgent",
    name: "Test Coverage Orchestrator",
    instructions: `You are an expert test coverage orchestrator.

Your job:
- Detect the project type and test framework
- Install required dependencies
- Execute the right coverage command
- Parse coverage from files or stdout
- Always return strict JSON with a 0..1 coverage ratio

Tools available:
- coverage_detection: detect repo language, framework, install and run commands
- coverage_runner: run install and coverage commands in Docker
- coverage_parse: parse coverage ratio (0..1) from coverage files or stdout
- docker_exec: run arbitrary commands when needed
- file_operations: read/write files in container when needed
- exec_command: run host shell commands if necessary

You must:
- Keep actions minimal and deterministic
- Prefer coverage files over stdout parsing
- Return JSON shape: { "repoPath": string, "language": string, "framework": string, "coverage": number }
`,
    model: openai("gpt-5-mini", {
        parallelToolCalls: true,
        reasoningEffort: "low",
    }),
    tools: {
        coverage_detection: coverageDetectionTool,
        coverage_runner: coverageRunnerTool,
        coverage_parse: coverageParseTool,
        docker_exec: dockerExecTool,
        file_operations: fileOperationsTool,
        exec_command: cliTool,
    },
});


