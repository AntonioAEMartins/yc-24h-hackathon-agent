import { createTool } from "@mastra/core";
import z from "zod";

export const cliToolMetrics = {
    callCount: 0,
};

export const cliTool = createTool({
    id: "exec_command",
    description: "Run a shell command locally",
    inputSchema: z.object({
        cmd: z.string().describe("The shell command to run"),
    }),
    execute: async ({ context }) => {
        const cmd = context?.cmd;
        if (!cmd || typeof cmd !== "string") {
            throw new Error("cmd is required and must be a string");
        }

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");
        return await new Promise((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    },
});