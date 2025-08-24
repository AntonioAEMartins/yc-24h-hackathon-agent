import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

function sh(cmd: string): Promise<{ stdout: string; stderr: string }>{
    return new Promise((resolve, reject) => {
        const { exec } = require("child_process");
        exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error: any, stdout: string, stderr: string) => {
            if (error) {
                resolve({ stdout: stdout + (stderr || ''), stderr: stderr || error.message });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

function shellEscape(str: string): string {
    return "'" + String(str).replace(/'/g, "'\"'\"'") + "'";
}

export const coverageRunnerTool = createTool({
    id: "coverage_runner",
    description: "Run installation and coverage command inside Docker container and return stdout/stderr",
    inputSchema: z.object({
        containerId: z.string(),
        repoPath: z.string(),
        install: z.string().nullable().optional(),
        run: z.string(),
    }),
    execute: async ({ context }) => {
        const { containerId, repoPath, install, run } = context as any;
        if (!containerId || !repoPath || !run) throw new Error("containerId, repoPath and run are required");
        cliToolMetrics.callCount += 1;

        if (install && typeof install === 'string' && install.trim()) {
            await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && ${install}"`).catch(() => {});
        }

        const { stdout, stderr } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && ${run} 2>&1 || true"`);
        return { stdout, stderr };
    },
});


