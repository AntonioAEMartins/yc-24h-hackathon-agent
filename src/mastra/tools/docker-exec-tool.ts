import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

export const dockerExecTool = createTool({
    id: "docker_exec",
    description: "Run a shell command inside a docker container (read-only, non-destructive). Uses: docker exec <containerId> bash -lc \"<cmd>\"",
    inputSchema: z.object({
        containerId: z.string().describe("Docker container ID or name"),
        cmd: z.string().describe("The bash command to run inside the container"),
    }),
    execute: async ({ context }) => {
        const containerId = context?.containerId;
        const cmd = context?.cmd;
        if (!containerId || typeof containerId !== "string") {
            throw new Error("containerId is required and must be a string");
        }
        if (!cmd || typeof cmd !== "string") {
            throw new Error("cmd is required and must be a string");
        }

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");
        const wrapped = JSON.stringify(cmd);
        const full = `docker exec ${containerId} bash -lc ${wrapped}`;
        return await new Promise((resolve, reject) => {
            exec(full, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    },
});


