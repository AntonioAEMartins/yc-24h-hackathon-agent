import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { existsSync } from "fs";
import path from "path";

const testDockerStep = createStep({
    id: "test-docker-step",
    inputSchema: z.object({
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
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
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
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
                            });
                        }
                    });
                });
            });
        });
    }
});

export const testDockerWorkflow = createWorkflow({
    id: "test-docker-workflow",
    description: "Test the Docker agent by building ubuntu:22.04 image, creating and running a container, and returning its ID",
    inputSchema: z.object({
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
    }),
}).then(testDockerStep).then(testDockerGithubCloneStep).commit();