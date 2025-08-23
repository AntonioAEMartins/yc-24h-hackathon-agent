import { Agent } from "@mastra/core";
import { cliTool } from "../tools/cli-tool";
import { openai } from "@ai-sdk/openai";

export const dockerAgent = new Agent({
    id: "dockerAgent",
    name: "Docker Agent",
    instructions: "You are a Docker agent responsible for creating, starting, stopping and removing Docker containers. With only one restriction, you should not use or remove dockers that where not created by you.",
    model: openai("gpt-5-nano", {
        parallelToolCalls: true,
    }),
    tools: {
        exec_command: cliTool,
    },
})