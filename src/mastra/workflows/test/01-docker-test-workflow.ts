import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { existsSync, writeFileSync, unlinkSync, mkdtempSync } from "fs";
import path from "path";
import os from "os";

const testDockerStep = createStep({
    id: "test-docker-step",
    inputSchema: z.object({
        contextData: z.any().optional().describe("Optional context data to pass through"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
    }),
    execute: async ({ inputData }) => {
        const agent = mastra?.getAgent("dockerAgent");
        if (!agent) {
            throw new Error("Docker agent not found");
        }

        const command = `You must use the exec_command tool to run shell commands. Do not simulate results.

Task:
1) Build a Docker image named yc-ubuntu:22.04 from ubuntu:22.04 with:
   - Install git
   - WORKDIR /app
2) Create and start a container named yc-ubuntu-test in detached interactive mode that keeps running.
3) Output ONLY the container ID as the final answer (single line, no extra text).

Run these exact commands in order:

docker build -t yc-ubuntu:22.04 -<<'EOF'
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
CMD ["bash"]
EOF

# Remove any existing container with the same name to avoid conflicts
docker rm -f yc-ubuntu-test || true

# Run the container (no TTY needed)
docker run -d --name yc-ubuntu-test yc-ubuntu:22.04 tail -f /dev/null

docker inspect -f '{{.Id}}' yc-ubuntu-test`;

        const result: any = await agent.generate(command,
            {
                maxSteps: 100,
                maxRetries: 5,
            }
        );

        const containerId = (result?.text || "").trim();

        return {
            result: result?.text || "Operation completed",
            success: true,
            toolCallCount: cliToolMetrics.callCount,
            containerId,
            contextData: inputData.contextData,
        };
    }
});

const testDockerGithubCloneStep = createStep({
    id: "test-docker-github-clone-step",
    inputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
    }),
    execute: async ({ inputData }) => {
        return await new Promise((resolve, reject) => {
            // Copy PAT into container and use it to clone the repo, then remove the file
            const cwd = process.cwd();
            let credentialsPath = path.resolve(cwd, ".docker.credentials");
            const fallbackPath = path.resolve(cwd, "..", "..", ".docker.credentials");
            if (!existsSync(credentialsPath) && existsSync(fallbackPath)) {
                credentialsPath = fallbackPath;
            }
            if (!existsSync(credentialsPath)) {
                reject(new Error(`.docker.credentials not found. Checked: ${credentialsPath}`));
                return;
            }

            // First, copy the credentials file to the container
            const copyCmd = `docker cp "${credentialsPath}" ${inputData.containerId}:/root/.docker.credentials`;
            
            exec(copyCmd, (copyError, copyStdout, copyStderr) => {
                if (copyError) {
                    reject(new Error(`Failed to copy credentials file: ${copyStderr || copyError.message}`));
                    return;
                }

                // Verify the file was copied successfully
                const verifyCmd = `docker exec ${inputData.containerId} test -f /root/.docker.credentials`;
                
                exec(verifyCmd, (verifyError, verifyStdout, verifyStderr) => {
                    if (verifyError) {
                        reject(new Error(`Credentials file not found in container after copy: ${verifyStderr || verifyError.message}`));
                        return;
                    }

                    // Now execute the git clone command
                    const execCmd = `docker exec ${inputData.containerId} bash -c "set -e; TOKEN=\\$(grep GITHUB_PAT /root/.docker.credentials | cut -d'=' -f2 | tr -d '[:space:]'); if [ -z \\"\\\$TOKEN\\" ]; then echo 'Error: GITHUB_PAT not found or empty in credentials file'; exit 1; fi; cd /app; git clone https://x-access-token:\\$TOKEN@github.com/AntonioAEMartins/yc-24h-hackathon-agent.git; rm -f /root/.docker.credentials; echo 'Repository cloned successfully'"`;
                    
                    exec(execCmd, (execError, execStdout, execStderr) => {
                        if (execError) {
                            reject(new Error(`Git clone failed: ${execStderr || execError.message}`));
                        } else {
                            resolve({
                                result: execStdout,
                                success: true,
                                toolCallCount: cliToolMetrics.callCount,
                                containerId: inputData.containerId,
                                contextData: inputData.contextData,
                            });
                        }
                    });
                });
            });
        });
    }
});

const saveContextStep = createStep({
    id: "save-context-step",
    inputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data to save to the container"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextPath: z.string().describe("Path where context was saved in the container"),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextData } = inputData;
        const logger = mastra?.getLogger();
        const contextPath = "/app/agent.context.json";
        
        logger?.info("💾 Starting code-based context save to Docker container", {
            containerId: containerId.substring(0, 12),
            contextPath,
            hasContextData: !!contextData,
            type: "DOCKER_CONTEXT_SAVE",
            runId: runId,
        });

        try {
            // Error if no context data provided - this indicates a workflow issue
            if (!contextData) {
                const error = "No context data provided to saveContextStep - workflow execution error";
                logger?.error("❌ Context data missing", {
                    error,
                    type: "DOCKER_CONTEXT_SAVE",
                    runId: runId,
                });
                throw new Error(error);
            }

            const contextToSave = contextData;

            // Convert context to JSON string
            const contextJson = JSON.stringify(contextToSave, null, 2);
            
            logger?.debug("📝 Preparing to write context directly to container", {
                contextSize: `${Math.round(contextJson.length / 1024)}KB`,
                contextPath,
                type: "DOCKER_CONTEXT_SAVE",
                runId: runId,
            });

            // Write context file to temp location then copy to Docker container (fast and reliable)
            return await new Promise((resolve, reject) => {
                let tempFilePath: string | null = null;
                
                try {
                    // Create temp file with JSON content
                    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'docker-context-'));
                    tempFilePath = path.join(tempDir, 'context.json');
                    writeFileSync(tempFilePath, contextJson, 'utf8');
                    
                    logger?.debug("🐳 Copying context file to Docker container", {
                        tempFilePath,
                        contextPath,
                        type: "DOCKER_CONTEXT_SAVE",
                        runId: runId,
                    });

                    // Copy file to container
                    const copyCmd = `docker cp "${tempFilePath}" ${containerId}:${contextPath}`;
                    
                    exec(copyCmd, (copyError, copyStdout, copyStderr) => {
                        // Clean up temp file
                        if (tempFilePath) {
                            try {
                                unlinkSync(tempFilePath);
                            } catch (cleanupError) {
                                logger?.warn("⚠️  Failed to cleanup temp file", {
                                    tempFilePath,
                                    error: cleanupError instanceof Error ? cleanupError.message : 'Unknown error',
                                    type: "DOCKER_CONTEXT_SAVE",
                                    runId: runId,
                                });
                            }
                        }

                        if (copyError) {
                            logger?.error("❌ Failed to copy context file to container", {
                                error: copyStderr || copyError.message,
                                type: "DOCKER_CONTEXT_SAVE",
                                runId: runId,
                            });
                            reject(new Error(`Failed to copy context file to container: ${copyStderr || copyError.message}`));
                            return;
                        }

                        // Verify file exists and has content
                        const verifyCmd = `docker exec ${containerId} bash -c "test -f ${contextPath} && wc -c ${contextPath}"`;
                        
                        exec(verifyCmd, (verifyError, verifyStdout, verifyStderr) => {
                            if (verifyError) {
                                logger?.error("❌ Context file verification failed", {
                                    error: verifyStderr || verifyError.message,
                                    type: "DOCKER_CONTEXT_SAVE",
                                    runId: runId,
                                });
                                reject(new Error(`Context file verification failed: ${verifyStderr || verifyError.message}`));
                                return;
                            }

                            const fileSize = verifyStdout.trim().split(' ')[0] || '0';
                            logger?.info("✅ Context file successfully saved to Docker container", {
                                containerId: containerId.substring(0, 12),
                                contextPath,
                                fileSize: `${parseInt(fileSize)} bytes`,
                                contextSize: `${Math.round(contextJson.length / 1024)}KB`,
                                type: "DOCKER_CONTEXT_SAVE",
                                runId: runId,
                            });

                            resolve({
                                result: `Context successfully saved to ${contextPath} (${fileSize} bytes, ${Math.round(contextJson.length / 1024)}KB)`,
                                success: true,
                                toolCallCount: cliToolMetrics.callCount,
                                containerId,
                                contextPath,
                            });
                        });
                    });
                } catch (tempError) {
                    // Clean up temp file on error
                    if (tempFilePath) {
                        try {
                            unlinkSync(tempFilePath);
                        } catch (cleanupError) {
                            // Ignore cleanup errors
                        }
                    }
                    
                    logger?.error("❌ Failed to create temp file for context", {
                        error: tempError instanceof Error ? tempError.message : 'Unknown error',
                        type: "DOCKER_CONTEXT_SAVE",
                        runId: runId,
                    });
                    reject(new Error(`Failed to create temp file: ${tempError instanceof Error ? tempError.message : 'Unknown error'}`));
                }
            });

        } catch (error) {
            logger?.error("❌ Context save operation failed", {
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "DOCKER_CONTEXT_SAVE",
                runId: runId,
            });

            return {
                result: `Context save failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                success: false,
                toolCallCount: cliToolMetrics.callCount,
                containerId,
                contextPath,
            };
        }
    }
});

export const testDockerWorkflow = createWorkflow({
    id: "test-docker-workflow",
    description: "Build Docker container, clone repository, and save context data efficiently using code-based operations",
    inputSchema: z.object({
        contextData: z.any().optional().describe("Optional context data to save to the container"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextPath: z.string().describe("Path where context was saved in the container"),
    }),
}).then(testDockerStep).then(testDockerGithubCloneStep).then(saveContextStep).commit();