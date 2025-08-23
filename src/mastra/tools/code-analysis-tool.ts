import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

export const codeAnalysisTool = createTool({
    id: "code_analysis",
    description: "Perform deep analysis of source code files to extract structure, functions, classes, and testing requirements",
    inputSchema: z.object({
        containerId: z.string().describe("Docker container ID to run analysis in"),
        filePath: z.string().describe("Path to the source code file to analyze"),
        analysisType: z.enum(["structure", "functions", "dependencies", "exports", "full"]).describe("Type of analysis to perform"),
        language: z.string().optional().describe("Programming language (auto-detected if not provided)"),
    }),
    execute: async ({ context }) => {
        const { containerId, filePath, analysisType, language } = context;
        if (!containerId || typeof containerId !== "string") {
            throw new Error("containerId is required and must be a string");
        }
        if (!filePath || typeof filePath !== "string") {
            throw new Error("filePath is required and must be a string");
        }
        if (!analysisType) {
            throw new Error("analysisType is required");
        }

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");

        // Build analysis commands based on type
        let commands = [];
        
        // Check if file exists first
        commands.push(`docker exec ${containerId} bash -lc "test -f ${filePath} && echo 'FILE_EXISTS' || echo 'FILE_NOT_FOUND'"`);
        
        if (analysisType === "structure" || analysisType === "full") {
            // Get basic file structure and language detection
            commands.push(`docker exec ${containerId} bash -lc "file ${filePath}"`);
            commands.push(`docker exec ${containerId} bash -lc "wc -l ${filePath}"`);
            commands.push(`docker exec ${containerId} bash -lc "head -20 ${filePath}"`);
        }

        if (analysisType === "functions" || analysisType === "full") {
            // Language-specific function extraction
            if (language === "typescript" || language === "javascript" || filePath.endsWith(".ts") || filePath.endsWith(".js")) {
                // Extract functions, classes, exports for TS/JS
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'function\\|class\\|const.*=\\|export' ${filePath} || true"`);
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'async\\|await\\|Promise' ${filePath} || true"`);
            } else if (language === "python" || filePath.endsWith(".py")) {
                // Extract functions, classes for Python
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'def\\|class\\|@' ${filePath} || true"`);
            } else {
                // Generic pattern matching
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'function\\|class\\|def\\|fn\\|func' ${filePath} || true"`);
            }
        }

        if (analysisType === "dependencies" || analysisType === "full") {
            // Extract imports and dependencies
            commands.push(`docker exec ${containerId} bash -lc "grep -n 'import\\|require\\|from.*import' ${filePath} || true"`);
        }

        if (analysisType === "exports" || analysisType === "full") {
            // Extract exports
            commands.push(`docker exec ${containerId} bash -lc "grep -n 'export\\|module.exports' ${filePath} || true"`);
        }

        // Execute all commands and collect results
        const results = [];
        for (const cmd of commands) {
            try {
                const result = await new Promise<string>((resolve, reject) => {
                    exec(cmd, (error, stdout, stderr) => {
                        if (error) {
                            // Don't reject for grep not finding patterns
                            if (cmd.includes('grep') && error.code === 1) {
                                resolve("");
                            } else {
                                reject(new Error(stderr || error.message));
                            }
                        } else {
                            resolve(stdout);
                        }
                    });
                });
                results.push({ command: cmd, output: result.trim() });
            } catch (error) {
                results.push({ 
                    command: cmd, 
                    output: "", 
                    error: error instanceof Error ? error.message : 'Unknown error' 
                });
            }
        }

        // Structure the results
        const analysisResult = {
            filePath,
            analysisType,
            language: language || "auto-detected",
            fileExists: results[0]?.output === "FILE_EXISTS",
            results: results.slice(1), // Skip the file existence check
            timestamp: new Date().toISOString(),
        };

        return analysisResult;
    },
});
