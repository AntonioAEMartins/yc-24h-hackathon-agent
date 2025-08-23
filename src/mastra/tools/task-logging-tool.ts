import { createTool } from "@mastra/core";
import z from "zod";

// Task status tracking
export interface TaskEvent {
    agentId: string;
    taskId: string;
    taskName: string;
    status: 'started' | 'completed' | 'failed' | 'planning' | 'coding' | 'validating';
    timestamp: Date;
    metadata?: Record<string, any>;
}

// In-memory task tracking (could be replaced with persistent storage)
export const taskEvents: TaskEvent[] = [];

export const taskLoggingTool = createTool({
    id: "task_logging",
    description: "Log agent task events for tracking and coordination",
    inputSchema: z.object({
        agentId: z.string().describe("Unique identifier for the agent"),
        taskId: z.string().describe("Unique identifier for the task"),
        taskName: z.string().describe("Human-readable task name"),
        status: z.enum(['started', 'completed', 'failed', 'planning', 'coding', 'validating']).describe("Current task status"),
        metadata: z.record(z.any()).optional().describe("Additional task metadata"),
    }),
    execute: async ({ context }) => {
        const { agentId, taskId, taskName, status, metadata } = context;
        
        const event: TaskEvent = {
            agentId,
            taskId,
            taskName,
            status,
            timestamp: new Date(),
            metadata: metadata || {}
        };
        
        taskEvents.push(event);
        
        // Log to console for immediate visibility
        const timestamp = event.timestamp.toISOString();
        const metadataStr = metadata ? ` | ${JSON.stringify(metadata)}` : '';
        console.log(`[${timestamp}] Agent:${agentId} | Task:${taskId} (${taskName}) | Status:${status}${metadataStr}`);
        
        return {
            success: true,
            message: `Task event logged: ${agentId}/${taskId} - ${status}`,
            eventId: taskEvents.length - 1,
            timestamp: timestamp
        };
    },
});

// Helper functions for task coordination
export function getAgentTasks(agentId: string): TaskEvent[] {
    return taskEvents.filter(event => event.agentId === agentId);
}

export function getTaskStatus(taskId: string): TaskEvent | undefined {
    return taskEvents
        .filter(event => event.taskId === taskId)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
}

export function getActiveTasksForAgent(agentId: string): TaskEvent[] {
    const agentTasks = getAgentTasks(agentId);
    const activeTasks = new Map<string, TaskEvent>();
    
    // Get the latest status for each task
    agentTasks.forEach(event => {
        const current = activeTasks.get(event.taskId);
        if (!current || event.timestamp > current.timestamp) {
            activeTasks.set(event.taskId, event);
        }
    });
    
    // Return only tasks that are still active (not completed or failed)
    return Array.from(activeTasks.values()).filter(event => 
        event.status !== 'completed' && event.status !== 'failed'
    );
}

export function clearTaskHistory(): void {
    taskEvents.length = 0;
    console.log('Task history cleared');
}
