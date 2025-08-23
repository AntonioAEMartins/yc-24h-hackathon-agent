import z from "zod";

export const AlertLevelSchema = z.enum(['debug', 'info', 'success', 'warning', 'error']);
export type AlertLevel = z.infer<typeof AlertLevelSchema>;

export const AlertStatusSchema = z.enum(['starting', 'in_progress', 'completed', 'failed']);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

// Rich alert payload describing workflow and step lifecycle.
// Backend can correlate events using (workflowId, runId, stepId) triplet.
export const AlertEventSchema = z.object({
    // Required minimal display fields
    title: z.string().min(1),
    subtitle: z.string().min(1),

    // Meta
    level: AlertLevelSchema.default('info'),
    source: z.string().optional().default('mastra-agent'),

    // Correlation identifiers
    projectId: z.string().optional(),
    runId: z.string().optional(),
    stepId: z.string().optional(),
    status: AlertStatusSchema.optional(), // starting | in_progress | completed | failed

    // Operational context
    containerId: z.string().optional(),
    contextPath: z.string().optional(),
    toolCallCount: z.number().optional(),
    metadata: z.record(z.any()).optional(),

    // Event time
    timestamp: z.string().datetime().optional(),
});
export type AlertEventPayload = z.infer<typeof AlertEventSchema>;

// In-memory association between a run and the project it belongs to.
// This lets us enrich alerts with projectId without forcing every step to pass it explicitly.
const runIdToProjectId = new Map<string, string>();
export function associateRunWithProject(runId: string, projectId: string): void {
    if (runId && projectId) {
        runIdToProjectId.set(runId, projectId);
    }
}
export function getProjectIdForRun(runId?: string): string | undefined {
    return runId ? runIdToProjectId.get(runId) : undefined;
}

function getAlertsApiUrl(): string {
    // Prefer explicit env var; default to conventional Next.js API route
    return process.env.ALERTS_API_URL || 'http://localhost:3000/api/alerts';
}

export async function sendAlertEvent(payload: AlertEventPayload): Promise<void> {
    try {
        // Validate before sending to ensure consistent contract
        const safe = AlertEventSchema.safeParse(payload);
        if (!safe.success) {
            // eslint-disable-next-line no-console
            console.warn('sendAlertEvent: invalid payload', safe.error.flatten());
        }
        const res = await fetch(getAlertsApiUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                level: payload.level || 'info',
                source: payload.source || 'mastra-agent',
                timestamp: payload.timestamp || new Date().toISOString(),
            }),
        });

        // Swallow non-2xx but log to console for debugging
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            // eslint-disable-next-line no-console
            console.warn(`sendAlertEvent: backend responded ${res.status}: ${text}`);
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('sendAlertEvent: failed to POST alert event', err);
    }
}

export async function notifyStepStatus(params: {
    stepId: string;
    status: AlertStatus;
    runId?: string;
    projectId?: string;
    containerId?: string;
    contextPath?: string;
    toolCallCount?: number;
    level?: AlertLevel;
    title?: string;
    subtitle?: string;
    metadata?: Record<string, any>;
}): Promise<void> {
    const { stepId, status, runId, projectId: paramProjectId, containerId, contextPath, toolCallCount, level, title, subtitle, metadata } = params;

    // Resolve projectId from param or association map
    const projectId = paramProjectId || getProjectIdForRun(runId);

    // console.log("🔔 Notifying step status", {
    //     title: title || `[${stepId}] ${status}`,
    //     subtitle: subtitle || `Step ${stepId} is ${status}`,
    //     stepId,
    //     status,
    //     runId,
    //     workflowId,
    //     containerId,
    //     contextPath,
    //     toolCallCount,
    //     level,
    //     metadata,
    // });

    await sendAlertEvent({
        title: title || `[${stepId}] ${status}`,
        subtitle: subtitle || `Step ${stepId} is ${status}`,
        level: level || (status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info'),
        source: 'mastra-agent',
        projectId,
        runId,
        stepId,
        status,
        containerId,
        contextPath,
        toolCallCount,
        metadata,
    });
}


/**
 * Convert workflow title/subtitle pairs into concise, user-friendly messages.
 * Covers the known steps from:
 * - 01-docker-test-workflow.ts
 * - 02-gather-context-workflow.ts
 * - 03-generate-unit-tests-workflow.ts
 * - full-pipeline-workflow.ts
 * Falls back to a sensible join of title and subtitle when unknown.
 */
export function formatFriendlyAlert(title?: string, subtitle?: string): string {
    const rawTitle = (title || '').trim();
    const rawSubtitle = (subtitle || '').trim();

    function join(main: string, detail?: string) {
        return detail ? `${main} — ${detail}` : main;
    }

    // ----- Docker setup & repository clone -----
    if (/docker setup completed/i.test(rawTitle)) {
        const match = rawSubtitle.match(/\(([a-f0-9]{7,64})\)/i) || rawSubtitle.match(/([a-f0-9]{12,64})/i);
        const shortId = match ? match[1].substring(0, 12) : undefined;
        return shortId ? `Docker ready (container ${shortId})` : 'Docker ready';
    }
    if (/^docker setup$/i.test(rawTitle)) {
        if (/building image/i.test(rawSubtitle)) {
            return 'Setting up Docker — building image and starting container';
        }
        return 'Setting up Docker';
    }
    if (/^cloning repository$/i.test(rawTitle)) {
        return 'Cloning repository into container';
    }
    if (/^repository cloned$/i.test(rawTitle)) {
        return 'Repository cloned successfully';
    }
    if (/^saving context to container$/i.test(rawTitle)) {
        const hasData = /provided/i.test(rawSubtitle);
        return `Saving context to container — ${hasData ? 'with data' : 'no data'}`;
    }
    if (/^context saved$/i.test(rawTitle)) {
        const pathMatch = rawSubtitle.match(/Saved to\s+(.+)/i);
        return pathMatch ? `Context saved to ${pathMatch[1].trim()}` : 'Context saved';
    }

    // ----- Gather context: analysis steps -----
    if (/^analyze repository completed$/i.test(rawTitle)) {
        const msg = rawSubtitle.replace(/^Type:\s*/i, 'type: ').trim();
        return join('Repository analysis complete', msg);
    }
    if (/^analyze repository$/i.test(rawTitle)) {
        return join('Analyzing repository', rawSubtitle || 'quick scan starting');
    }
    if (/^analyze codebase completed$/i.test(rawTitle)) {
        const msg = rawSubtitle.replace(/^Frameworks:\s*/i, 'frameworks: ').trim();
        return join('Codebase analysis complete', msg);
    }
    if (/^analyze codebase$/i.test(rawTitle)) {
        return join('Analyzing codebase', rawSubtitle || undefined);
    }
    if (/^analyze build & deployment completed$/i.test(rawTitle)) {
        const msg = rawSubtitle.replace(/^Build system:\s*/i, 'build system: ').trim();
        return join('Build & deployment analysis complete', msg);
    }
    if (/^analyze build & deployment$/i.test(rawTitle)) {
        return join('Analyzing build & deployment', rawSubtitle || 'DevOps scan starting');
    }
    if (/^synthesize context completed$/i.test(rawTitle)) {
        return 'Context synthesized — executive summary generated';
    }
    if (/^synthesize context$/i.test(rawTitle)) {
        return join('Synthesizing context', rawSubtitle || undefined);
    }

    // ----- Gather context: saving & validation -----
    if (/^save unit test context$/i.test(rawTitle)) {
        return join('Saving unit test context', rawSubtitle || 'writing agent.context.json');
    }
    if (/^saved unit test context$/i.test(rawTitle)) {
        const msgRaw = rawSubtitle.replace(/^Path:\s*/i, 'to ').trim();
        const msg = /^to\s+/i.test(msgRaw) ? msgRaw : `to ${msgRaw}`;
        return `Unit test context saved ${msg}`;
    }
    if (/^validate and summarize$/i.test(rawTitle)) {
        return join('Validating and summarizing', rawSubtitle || 'final validation starting');
    }
    if (/^validation completed$/i.test(rawTitle)) {
        return join('Validation complete', rawSubtitle || undefined);
    }
    if (/^gather workflow start$/i.test(rawTitle)) {
        return join('Starting gather workflow', rawSubtitle || 'planning and setup');
    }
    if (/^gather workflow initialized$/i.test(rawTitle)) {
        return join('Gather workflow initialized', rawSubtitle || 'plan logged');
    }

    // ----- Unit test generation workflow -----
    if (/^check saved plan$/i.test(rawTitle)) {
        return join('Checking for saved plan', rawSubtitle || undefined);
    }
    if (/^saved plan found$/i.test(rawTitle)) {
        return 'Saved plan found — skipping planning';
    }
    if (/^no saved plan$/i.test(rawTitle)) {
        return 'No saved plan — proceeding to plan';
    }
    if (/^load context & plan$/i.test(rawTitle)) {
        return join('Planning test generation', rawSubtitle || 'creating MVP plan');
    }
    if (/^test generation completed$/i.test(rawTitle)) {
        return join('Test generation completed', rawSubtitle || 'test file created');
    }
    if (/^test generation failed$/i.test(rawTitle)) {
        return join('Test generation failed', rawSubtitle || undefined);
    }
    if (/^finalize$/i.test(rawTitle)) {
        return join('Finalizing', rawSubtitle || 'validation and recommendations');
    }
    if (/^finalize completed$/i.test(rawTitle)) {
        return join('Finalized', rawSubtitle || undefined);
    }

    // ----- Generic failures -----
    if (/failed$/i.test(rawTitle)) {
        const base = rawTitle.replace(/\s*failed$/i, '').trim();
        return join(`Failed — ${base}`, rawSubtitle || undefined);
    }

    // ----- Fallback -----
    if (rawTitle && rawSubtitle) return `${rawTitle} — ${rawSubtitle}`;
    return rawTitle || rawSubtitle || 'Update';
}


