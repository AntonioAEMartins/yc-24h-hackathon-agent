import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

export const fileOperationsTool = createTool({
    id: "file_operations",
    description: "Perform file operations like reading, writing, creating directories for test files",
    inputSchema: z.object({
        containerId: z.string().describe("Docker container ID to run operations in"),
        operation: z.enum(["read", "write", "create_dir", "list", "exists", "copy"]).describe("File operation to perform"),
        filePath: z.string().describe("Path to the file or directory"),
        content: z.string().optional().describe("Content to write (for write operation)"),
        targetPath: z.string().optional().describe("Target path (for copy operation)"),
    }),
    execute: async ({ context }) => {
        const { containerId, operation, filePath, content, targetPath } = context;
        
        if (!containerId || typeof containerId !== "string") {
            throw new Error("containerId is required and must be a string");
        }
        if (!operation) {
            throw new Error("operation is required");
        }
        if (!filePath || typeof filePath !== "string") {
            throw new Error("filePath is required and must be a string");
        }

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");

        let command = "";
        
        switch (operation) {
            case "read":
                command = `docker exec ${containerId} bash -lc "cat ${JSON.stringify(filePath)}"`;
                break;
                
            case "write":
                if (!content) {
                    throw new Error("content is required for write operation");
                }
                // Escape content for shell
                const escapedContent = content.replace(/'/g, "'\"'\"'");
                command = `docker exec ${containerId} bash -lc "echo '${escapedContent}' > ${JSON.stringify(filePath)}"`;
                break;
                
            case "create_dir":
                command = `docker exec ${containerId} bash -lc "mkdir -p ${JSON.stringify(filePath)}"`;
                break;
                
            case "list":
                command = `docker exec ${containerId} bash -lc "ls -la ${JSON.stringify(filePath)}"`;
                break;
                
            case "exists":
                command = `docker exec ${containerId} bash -lc "test -e ${JSON.stringify(filePath)} && echo 'EXISTS' || echo 'NOT_EXISTS'"`;
                break;
                
            case "copy":
                if (!targetPath) {
                    throw new Error("targetPath is required for copy operation");
                }
                command = `docker exec ${containerId} bash -lc "cp ${JSON.stringify(filePath)} ${JSON.stringify(targetPath)}"`;
                break;
                
            default:
                throw new Error(`Unsupported operation: ${operation}`);
        }

        return await new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve({
                        operation,
                        filePath,
                        targetPath,
                        success: true,
                        output: stdout.trim(),
                        timestamp: new Date().toISOString(),
                    });
                }
            });
        });
    },
});
