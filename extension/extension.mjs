import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const MAX_EVENTS = 20_000;
const TRACKED_EVENT_TYPES = new Set([
    "assistant.turn_start",
    "assistant.turn_end",
    "assistant.usage",
    "tool.execution_complete",
    "skill.invoked",
]);
const SOURCE_CATEGORY_NAMES = {
    systemPrompt: "系统提示",
    customInstructions: "自定义指令",
    systemTools: "内置工具定义",
    mcpTools: "MCP 工具定义",
    messages: "对话消息（含工具结果）",
};
const FILE_QUERY_TOOLS = new Set([
    "cat",
    "file_search",
    "get_file_contents",
    "glob",
    "grep",
    "lexical_code_search",
    "read_file",
    "read_file_range",
    "rg",
    "search_code",
    "semantic_code_search",
    "view",
]);

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = await readFile(new URL("./dashboard.html", import.meta.url), "utf8");
const servers = new Map();
const recordedEvents = new Map();
let modelCatalogPromise;
let session;
let ledgerPath;
let trackingStartedAt = new Date().toISOString();
let eventOrdinal = 0;
let initializing = true;
let pendingEvents = [];
let processingQueue = Promise.resolve();
let persistenceQueue = Promise.resolve();
let initializationPromise = Promise.resolve();
let ledgerError;
let historyError;
let contextError;
let ledgerReadFailed = false;
let historyTruncated = false;

function numericOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
    const result = numericOrNull(value);
    return result !== null && result >= 0 ? result : 0;
}

function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}

function getModelCatalog() {
    if (!modelCatalogPromise) modelCatalogPromise = session.rpc.model.list({});
    return modelCatalogPromise;
}

async function reportError(kind, error) {
    const message = describeError(error);
    if (kind === "ledger") {
        if (ledgerError === message) return;
        ledgerError = message;
    } else if (kind === "history") {
        if (historyError === message) return;
        historyError = message;
    } else {
        if (contextError === message) return;
        contextError = message;
    }
    await session.log("Session AI Credits " + kind + " error: " + message, { level: "warning" });
}

function compactContext(context) {
    if (!context) return null;
    const categories = context.categories || {};
    const entries = Array.isArray(context.entries) ? context.entries : [];
    return {
        totalTokens: nonNegativeNumber(context.totalTokens),
        limit: nonNegativeNumber(context.limit),
        modelId: typeof context.modelId === "string" ? context.modelId : "",
        categories: {
            systemPrompt: nonNegativeNumber(categories.systemPrompt),
            customInstructions: nonNegativeNumber(categories.customInstructions),
            systemTools: nonNegativeNumber(categories.systemTools),
            mcpTools: nonNegativeNumber(categories.mcpTools),
            messages: nonNegativeNumber(categories.messages),
            freeSpace: nonNegativeNumber(categories.freeSpace),
            buffer: nonNegativeNumber(categories.buffer),
        },
        entries: entries
            .filter((entry) => ["skill", "subagent", "mcpServer", "tool", "plugin"].includes(entry.kind))
            .map((entry) => ({
                kind: entry.kind,
                id: entry.id,
                label: entry.label,
                tokens: nonNegativeNumber(entry.tokens),
                parentId: entry.parentId,
            })),
    };
}

function normalizeEvent(event, contextSnapshot) {
    if (!event || typeof event.id !== "string" || !TRACKED_EVENT_TYPES.has(event.type)) return null;
    const normalized = {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        agentId: typeof event.agentId === "string" ? event.agentId : "main",
    };
    const data = event.data || {};

    if (event.type === "assistant.turn_start") {
        normalized.data = {
            turnId: typeof data.turnId === "string" ? data.turnId : "",
            interactionId: typeof data.interactionId === "string" ? data.interactionId : "",
            model: typeof data.model === "string" ? data.model : "",
        };
        if (contextSnapshot) normalized.contextSnapshot = contextSnapshot;
    } else if (event.type === "assistant.turn_end") {
        normalized.data = { turnId: typeof data.turnId === "string" ? data.turnId : "" };
    } else if (event.type === "assistant.usage") {
        const usage = data.copilotUsage || {};
        normalized.data = {
            model: typeof data.model === "string" ? data.model : "",
            modelDisplayName: typeof data.modelDisplayName === "string" ? data.modelDisplayName : "",
            nanoAiu: numericOrNull(usage.totalNanoAiu),
            aiCreditsStatus: typeof data.aiCreditsStatus === "string" ? data.aiCreditsStatus : "",
            inputTokens: numericOrNull(data.inputTokens),
            outputTokens: numericOrNull(data.outputTokens),
            cacheReadTokens: numericOrNull(data.cacheReadTokens),
            cacheWriteTokens: numericOrNull(data.cacheWriteTokens),
            reasoningTokens: numericOrNull(data.reasoningTokens),
            interactionType: typeof data.interactionType === "string" ? data.interactionType : "",
            initiator: typeof data.initiator === "string" ? data.initiator : "",
        };
    } else if (event.type === "tool.execution_complete") {
        const toolName = typeof data.toolDescription?.name === "string" ? data.toolDescription.name : "";
        normalized.data = {
            turnId: typeof data.turnId === "string" ? data.turnId : "",
            toolName: toolName || "未命名工具",
            success: data.success === true,
        };
    } else if (event.type === "skill.invoked") {
        normalized.data = {
            name: typeof data.name === "string" ? data.name : "未命名 Skill",
            pluginName: typeof data.pluginName === "string" ? data.pluginName : "",
        };
    }
    return normalized;
}

function storeEvent(event, contextSnapshot = null) {
    const normalized = normalizeEvent(event, contextSnapshot);
    if (!normalized) return false;

    const existing = recordedEvents.get(normalized.id);
    if (existing) {
        if (normalized.type === "assistant.turn_start" && contextSnapshot && !existing.contextSnapshot) {
            existing.contextSnapshot = contextSnapshot;
            return true;
        }
        return false;
    }

    if (recordedEvents.size >= MAX_EVENTS) {
        const oldestId = recordedEvents.keys().next().value;
        if (oldestId) recordedEvents.delete(oldestId);
        historyTruncated = true;
    }
    normalized.ordinal = ++eventOrdinal;
    recordedEvents.set(normalized.id, normalized);
    return true;
}

async function persistLedger() {
    if (!ledgerPath || ledgerReadFailed) return;
    const snapshot = JSON.stringify({
        version: 1,
        trackingStartedAt,
        historyTruncated,
        events: Array.from(recordedEvents.values()),
    });
    persistenceQueue = persistenceQueue.then(async () => {
        await mkdir(dirname(ledgerPath), { recursive: true });
        const temporaryPath = ledgerPath + "." + process.pid + ".tmp";
        await writeFile(temporaryPath, snapshot, "utf8");
        await rename(temporaryPath, ledgerPath);
        ledgerError = undefined;
    }).catch(async (error) => {
        await reportError("ledger", error);
    });
    await persistenceQueue;
}

async function loadLedger() {
    ledgerPath = join(session.workspacePath || extensionDirectory, ".session-ai-credits-ledger.json");
    try {
        const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
        if (parsed.version !== 1 || !Array.isArray(parsed.events)) {
            throw new Error("本地用量明细文件格式不受支持");
        }
        if (typeof parsed.trackingStartedAt === "string") trackingStartedAt = parsed.trackingStartedAt;
        historyTruncated = parsed.historyTruncated === true;
        for (const event of parsed.events) {
            if (event && typeof event.id === "string" && TRACKED_EVENT_TYPES.has(event.type)) {
                eventOrdinal = Math.max(eventOrdinal, nonNegativeNumber(event.ordinal));
                recordedEvents.set(event.id, event);
            }
        }
    } catch (error) {
        if (error && error.code === "ENOENT") return;
        ledgerReadFailed = true;
        await reportError("ledger", error);
    }
}

async function readHistoricalEvents() {
    let cursor;
    let hasMore = true;
    let pageCount = 0;
    while (hasMore) {
        const page = await session.rpc.eventLog.read({
            ...(cursor ? { cursor } : {}),
            max: 1000,
            types: Array.from(TRACKED_EVENT_TYPES),
            includeEphemeral: true,
        });
        for (const event of page.events) storeEvent(event);
        cursor = page.cursor;
        hasMore = page.hasMore;
        pageCount += 1;
        if (pageCount > 200) throw new Error("读取 session 历史事件超过安全分页上限");
    }
}

async function captureLiveEvent(event) {
    if (!TRACKED_EVENT_TYPES.has(event.type)) return;
    let contextPromise;
    if (event.type === "assistant.turn_start") {
        contextPromise = session.rpc.metadata.getContextAttribution()
            .then((result) => {
                contextError = undefined;
                return compactContext(result.contextAttribution);
            })
            .catch(async (error) => {
                await reportError("context", error);
                return null;
            });
    }
    const item = { event, contextPromise };
    if (initializing) {
        pendingEvents.push(item);
        return;
    }
    enqueueLiveEvent(item);
}

function enqueueLiveEvent(item) {
    processingQueue = processingQueue.then(async () => {
        const contextSnapshot = item.contextPromise ? await item.contextPromise : null;
        if (storeEvent(item.event, contextSnapshot)) await persistLedger();
    }).catch(async (error) => {
        await reportError("history", error);
    });
}

async function initializeTracking() {
    await loadLedger();
    try {
        await readHistoricalEvents();
    } catch (error) {
        await reportError("history", error);
    }
    initializing = false;
    const queued = pendingEvents;
    pendingEvents = [];
    queued.sort((left, right) => Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp));
    for (const item of queued) enqueueLiveEvent(item);
    await processingQueue;
    await persistLedger();
}

function classifyTool(name) {
    const value = (name || "").toLowerCase();
    if (FILE_QUERY_TOOLS.has(value)) return "文件/代码查询";
    if (/^(mcp(?:__|:|\/|[-_])|[^/]+\/mcp__)/i.test(value)) return "MCP 工具";
    return "其他工具";
}

function contextSourceRows(context) {
    if (!context || !Array.isArray(context.entries)) return [];
    const entriesById = new Map(context.entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
    const parentIds = new Set(context.entries.map((entry) => entry.parentId).filter(Boolean));
    function hasMcpAncestor(entry) {
        let parentId = entry.parentId;
        const visited = new Set();
        while (parentId && !visited.has(parentId)) {
            visited.add(parentId);
            const parent = entriesById.get(parentId);
            if (!parent) return false;
            if (parent.kind === "mcpServer") return true;
            parentId = parent.parentId;
        }
        return false;
    }
    const rows = new Map();
    for (const entry of context.entries) {
        if (parentIds.has(entry.id)) continue;
        let category;
        if (entry.kind === "skill") category = "Skill";
        else if (entry.kind === "mcpServer") category = "MCP 来源";
        else if (entry.kind === "subagent") category = "子 Agent";
        else if (entry.kind === "plugin") category = "Plugin";
        else if (entry.kind === "tool") {
            const toolCategory = classifyTool(entry.label);
            if (toolCategory === "文件/代码查询") category = "文件/代码查询工具输出";
            else if (toolCategory === "MCP 工具" || hasMcpAncestor(entry)) category = "MCP 工具输出";
            else category = "其他工具输出";
        }
        else continue;
        const key = category + "\u0000" + entry.label;
        const current = rows.get(key) || { category, label: entry.label, tokens: 0 };
        current.tokens += nonNegativeNumber(entry.tokens);
        rows.set(key, current);
    }
    return Array.from(rows.values()).sort((left, right) => right.tokens - left.tokens);
}

function compactContextForClient(context) {
    if (!context) return null;
    return {
        totalTokens: context.totalTokens,
        limit: context.limit,
        modelId: context.modelId,
        categories: context.categories,
        sources: contextSourceRows(context),
    };
}

function addContextCategories(target, context, multiplier = 1) {
    if (!context) return;
    for (const key of Object.keys(SOURCE_CATEGORY_NAMES)) {
        target[key] += nonNegativeNumber(context.categories[key]) * multiplier;
    }
}

function buildUsageHistory(metrics) {
    const events = Array.from(recordedEvents.values()).sort((left, right) => {
        const timeDifference = Date.parse(left.timestamp) - Date.parse(right.timestamp);
        return Number.isFinite(timeDifference) && timeDifference !== 0
            ? timeDifference
            : nonNegativeNumber(left.ordinal) - nonNegativeNumber(right.ordinal);
    });
    const rounds = new Map();
    const turns = new Map();
    const activeTurns = new Map();

    function ensureRound(agentId, interactionId, timestamp) {
        const roundId = interactionId || "轮次";
        const key = agentId + "\u0000" + roundId;
        let round = rounds.get(key);
        if (!round) {
            const agent = (metrics.agentMetrics || {})[agentId];
            round = {
                key,
                interactionId: interactionId || "",
                agentId,
                agentLabel: agentId === "main"
                    ? "主对话"
                    : (agent?.agentDisplayName || agent?.agentName || "子 Agent"),
                startedAt: timestamp,
                turns: [],
                orphanCalls: [],
            };
            rounds.set(key, round);
        } else if (Date.parse(timestamp) < Date.parse(round.startedAt)) {
            round.startedAt = timestamp;
        }
        return round;
    }

    for (const event of events) {
        const agentId = event.agentId || "main";
        if (event.type === "assistant.turn_start") {
            const turnId = event.data.turnId || "unknown";
            const interactionId = event.data.interactionId || "";
            const round = ensureRound(agentId, interactionId, event.timestamp);
            const turnKey = agentId + "\u0000" + turnId;
            const turn = {
                turnId,
                startedAt: event.timestamp,
                contextSnapshot: event.contextSnapshot || null,
                calls: [],
                tools: [],
                skills: [],
            };
            turns.set(turnKey, turn);
            round.turns.push(turn);
            activeTurns.set(agentId, { round, turn });
        } else if (event.type === "assistant.usage") {
            const active = activeTurns.get(agentId);
            const call = { ...event.data, timestamp: event.timestamp };
            if (active) active.turn.calls.push(call);
            else {
                const round = ensureRound(agentId, "", event.timestamp);
                round.orphanCalls.push(call);
            }
        } else if (event.type === "assistant.turn_end") {
            const active = activeTurns.get(agentId);
            if (active && active.turn.turnId === event.data.turnId) activeTurns.delete(agentId);
        } else if (event.type === "tool.execution_complete") {
            const turn = event.data.turnId ? turns.get(agentId + "\u0000" + event.data.turnId) : activeTurns.get(agentId)?.turn;
            if (turn) turn.tools.push(event.data);
        } else if (event.type === "skill.invoked") {
            const active = activeTurns.get(agentId);
            if (active && !active.turn.skills.includes(event.data.name)) active.turn.skills.push(event.data.name);
        }
    }

    const publicRounds = [];
    const contextTotals = Object.fromEntries(Object.keys(SOURCE_CATEGORY_NAMES).map((key) => [key, 0]));
    const sourceTotals = new Map();
    let contextSnapshots = 0;
    let usageEvents = 0;

    for (const round of rounds.values()) {
        const calls = [...round.turns.flatMap((turn) => turn.calls), ...round.orphanCalls]
            .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
        usageEvents += calls.length;
        let creditsComplete = calls.length > 0;
        let nanoAiu = 0;
        let hasCredits = false;
        let inputTokens = 0;
        let outputTokens = 0;
        for (const call of calls) {
            if (typeof call.nanoAiu === "number" && Number.isFinite(call.nanoAiu)) {
                nanoAiu += call.nanoAiu;
                hasCredits = true;
            } else {
                creditsComplete = false;
            }
            if (call.aiCreditsStatus !== "complete") creditsComplete = false;
            inputTokens += nonNegativeNumber(call.inputTokens);
            outputTokens += nonNegativeNumber(call.outputTokens);
        }
        const expectedCalls = round.turns.length;
        if (calls.length < expectedCalls) creditsComplete = false;

        const roundContextTotals = Object.fromEntries(Object.keys(SOURCE_CATEGORY_NAMES).map((key) => [key, 0]));
        let roundContextSnapshots = 0;
        const toolSummary = { fileQueries: 0, mcp: 0, other: 0 };
        const skillNames = new Set();
        for (const turn of round.turns) {
            if (turn.contextSnapshot && turn.calls.length) {
                roundContextSnapshots += turn.calls.length;
                addContextCategories(roundContextTotals, turn.contextSnapshot, turn.calls.length);
                addContextCategories(contextTotals, turn.contextSnapshot, turn.calls.length);
                for (const source of contextSourceRows(turn.contextSnapshot)) {
                    const key = source.category + "\u0000" + source.label;
                    const current = sourceTotals.get(key) || { category: source.category, label: source.label, tokens: 0 };
                    current.tokens += source.tokens * turn.calls.length;
                    sourceTotals.set(key, current);
                }
            }
            for (const tool of turn.tools) {
                const category = classifyTool(tool.toolName);
                if (category === "文件/代码查询") toolSummary.fileQueries += 1;
                else if (category === "MCP 工具") toolSummary.mcp += 1;
                else toolSummary.other += 1;
            }
            for (const name of turn.skills) skillNames.add(name);
        }
        contextSnapshots += roundContextSnapshots;
        const contextTokens = roundContextSnapshots
            ? Object.keys(SOURCE_CATEGORY_NAMES).map((key) => ({
                label: SOURCE_CATEGORY_NAMES[key],
                tokens: roundContextTotals[key],
            }))
            : [];
        const firstTimestamp = round.turns.length
            ? round.turns[0].startedAt
            : calls[0]?.timestamp || round.startedAt;
        publicRounds.push({
            interactionId: round.interactionId ? round.interactionId.slice(0, 8) : "未关联",
            startedAt: firstTimestamp,
            agentLabel: round.agentLabel,
            expectedCalls,
            observedCalls: calls.length,
            nanoAiu: hasCredits ? nanoAiu : null,
            creditStatus: creditsComplete ? "complete" : "partial",
            inputTokens,
            outputTokens,
            calls,
            contextTokens,
            toolSummary,
            skills: Array.from(skillNames),
        });
    }

    publicRounds.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    const modelCallCount = Object.values(metrics.modelMetrics || {})
        .reduce((total, metric) => total + nonNegativeNumber(metric?.requests?.count), 0);
    const totalContextTokens = Object.values(contextTotals).reduce((total, count) => total + count, 0);
    return {
        rounds: publicRounds,
        usageEvents,
        modelCallCount,
        contextUsage: {
            snapshots: contextSnapshots,
            usageEvents,
            totalTokens: totalContextTokens,
            categories: contextTotals,
            sources: Array.from(sourceTotals.values()).sort((left, right) => right.tokens - left.tokens),
        },
    };
}

function summarizeMetrics(metrics) {
    const models = Object.entries(metrics.modelMetrics || {}).filter(([, metric]) => metric).map(([name, metric]) => ({
        label: name,
        nanoAiu: numericOrNull(metric.totalNanoAiu),
        calls: nonNegativeNumber(metric.requests?.count),
        inputTokens: nonNegativeNumber(metric.usage?.inputTokens),
        outputTokens: nonNegativeNumber(metric.usage?.outputTokens),
    })).sort((left, right) => (right.nanoAiu || 0) - (left.nanoAiu || 0));
    const agents = Object.entries(metrics.agentMetrics || {}).filter(([, metric]) => metric).map(([id, metric]) => {
        const modelStats = Object.values(metric.modelMetrics || {}).filter(Boolean);
        return {
            label: id === "main" ? "主对话" : (metric.agentDisplayName || metric.agentName || "子 Agent"),
            nanoAiu: numericOrNull(metric.totalNanoAiu),
            calls: modelStats.reduce((total, item) => total + nonNegativeNumber(item.requests?.count), 0),
            inputTokens: modelStats.reduce((total, item) => total + nonNegativeNumber(item.usage?.inputTokens), 0),
            outputTokens: modelStats.reduce((total, item) => total + nonNegativeNumber(item.usage?.outputTokens), 0),
        };
    }).sort((left, right) => (right.nanoAiu || 0) - (left.nanoAiu || 0));
    const modelCallCount = models.reduce((total, model) => total + model.calls, 0);
    return {
        totalNanoAiu: numericOrNull(metrics.totalNanoAiu),
        aiCreditsStatus: metrics.aiCreditsStatus || "unavailable",
        inputTokens: models.reduce((total, model) => total + model.inputTokens, 0),
        outputTokens: models.reduce((total, model) => total + model.outputTokens, 0),
        modelCallCount,
        models,
        agents,
        sessionStartTime: metrics.sessionStartTime,
    };
}

async function getDashboardData() {
    await initializationPromise;
    await processingQueue;
    const metrics = await session.rpc.usage.getMetrics();
    let currentContext = null;
    try {
        const result = await session.rpc.metadata.getContextAttribution();
        currentContext = compactContext(result.contextAttribution);
        contextError = undefined;
    } catch (error) {
        await reportError("context", error);
    }
    let modelCapacity = null;
    if (currentContext?.modelId) {
        try {
            const catalog = await getModelCatalog();
            const model = catalog.list.find((item) => item && typeof item === "object" && item.id === currentContext.modelId);
            const limits = model?.capabilities?.limits;
            if (limits) {
                modelCapacity = {
                    maxOutputTokens: nonNegativeNumber(limits.max_output_tokens),
                    maxContextWindowTokens: nonNegativeNumber(limits.max_context_window_tokens),
                };
            }
        } catch (error) {
            await reportError("model-capacity", error);
        }
    }
    const usage = buildUsageHistory(metrics);
    const summary = summarizeMetrics(metrics);
    return {
        metrics: summary,
        models: summary.models,
        agents: summary.agents,
        rounds: usage.rounds,
        currentContext: compactContextForClient(currentContext),
        modelCapacity,
        contextError,
        contextUsage: usage.contextUsage,
        coverage: {
            modelCallCount: usage.modelCallCount,
            usageEvents: usage.usageEvents,
            historyTruncated,
        },
        trackingStartedAt,
        ledgerError,
        historyError,
    };
}

function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
}

async function startServer() {
    const server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (request.method === "GET" && pathname === "/") {
            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
            });
            response.end(dashboardHtml);
            return;
        }
        if (request.method === "GET" && pathname === "/favicon.ico") {
            response.writeHead(204);
            response.end();
            return;
        }
        if (request.method === "GET" && pathname === "/api/dashboard") {
            try {
                sendJson(response, 200, await getDashboardData());
            } catch (error) {
                sendJson(response, 500, { error: describeError(error) });
            }
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise((resolve) => server.close(resolve));
        throw new Error("无法读取 AI Credits canvas 的本地服务地址");
    }
    return { server, url: "http://127.0.0.1:" + address.port + "/" };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "session-ai-credits",
            displayName: "Session AI Credits",
            description: "查看当前 session 每轮 AI Credits 明细，并按模型、Agent 和上下文来源分类统计 Token。",
            actions: [
                {
                    name: "refresh_usage",
                    description: "读取当前 session 的 AI Credits、逐轮用量和 Token 来源分类。",
                    handler: async () => getDashboardData(),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Session AI Credits", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve, reject) => {
                        entry.server.close((error) => error ? reject(error) : resolve());
                    });
                }
            },
        }),
    ],
});

session.on((event) => {
    void captureLiveEvent(event);
});
initializationPromise = initializeTracking();
await initializationPromise;
