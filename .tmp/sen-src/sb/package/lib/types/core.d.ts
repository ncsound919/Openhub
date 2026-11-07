import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { BridgeDescendantInfo } from './handoff.ts';
/** Live 会话 agent 的运行时形态（dsh-agent 公开类型较薄，用结构类型）。 */
export interface LiveAgentLike {
    readonly id: string;
    readonly status: 'running' | 'idle';
    readonly session: Session;
    readonly options?: {
        provider?: string;
        model?: string;
        reasoningEffort?: string;
    };
    followup(message: unknown): void;
    steer(message: unknown): void;
    cancel(cause?: unknown, options?: {
        keepInbox?: boolean;
    }): void;
    whenIdle?(): Promise<void>;
    readonly ctx: Context;
    readonly inbox?: {
        hasPending?: boolean;
        nextTurn?: readonly unknown[];
        nextStep?: readonly unknown[];
    };
}
export interface BridgeMessageRow {
    seq: number;
    time: number;
    role: 'user' | 'assistant';
    text?: string;
    reasoning?: string;
    images: number;
    toolCalls?: string[];
}
export interface BridgeWaitResult {
    message: BridgeMessageRow | null;
    seq: number;
    turnEnded: boolean;
    timedOut: boolean;
    /**
     * true = 返回的是等待开始前就已经存在的输出（整个等待窗口内没有出现新的文本
     * 回复 / 新段落）。此时 message 仍带正文，调用方据此区分"等到了新回复"与
     * "拿到的是既有回复"。不变式：stale === (message !== null && message.seq <= baselineSeq)。
     */
    stale: boolean;
    aborted: boolean;
    waitedMs: number;
}
export interface BridgeFindItem {
    sessionId: string;
    title?: string;
    cwd?: string;
    workspaceId?: string;
    live: boolean;
    running?: boolean;
    parentSession?: string;
    origin?: 'subagent';
    createdAt?: number;
    updatedAt?: number;
    agentPreset?: string;
}
/**
 * 兼容读取不同 dsh-session 版本上的会话事件：
 * - 旧版 \`Session\` 暴露 \`get events(): readonly SessionEvent[]\`；
 * - 新版将 \`get events\` 改为 \`snapshotEvents(fromSeq?, toSeqExclusive?)\` 方法——
 *   \`.events\` 直接读取会得到 \`undefined\`，对 for...of 迭代即抛
 *   \`events is not iterable\`。
 * 两者都读不到（或 session 不存在）时回退为空数组，绝不抛迭代错误。
 *
 * 注意：dsh 0.1.6-alpha.1 起 \`snapshotEvents()\`（连同 \`eventAt()\` /
 * \`ownEvents()\`）已标记 @deprecated —— 官方策略是"现有逻辑可暂不迁移，但禁止
 * 新增调用"；其替代不是同步读，而是（a）恢复后读取 Session 投影/派生状态，或
 * （b）按需异步分页读取历史窗口（见 dsh 决策
 * 2026-09-09-deprecate-synchronous-session-event-reads）。本函数的调用方
 * （foldMessages / segmentsSince / wait 基线）仍依赖完整同步快照，故按该决定暂缓
 * 迁移；将来官方补齐分页读后，只需改造这一个入口。
 */
export declare function sessionEvents(session: unknown): readonly SessionEvent[];
/** 规约任意"事件列表"值为数组（非数组 → []），避免 events is not iterable。 */
export declare function asEventList(events: unknown): readonly SessionEvent[];
/**
 * 读取一个持久化（离线）会话的事件日志与头部元数据。兼容两代 persistence API：
 * - 旧版：`sessionPersistence.inspect(id)` 直接返回 { events, meta }；
 * - dsh 0.1.5 之后：`inspect` 已删除，改用 `open(id, 'read')` → `handle.read()`
 *   （+ `handle.header`），读句柄不抢写所有权，读后必须 close()。
 * 会话不存在时两个 API 都抛错，调用方按原语义处理。
 * DSH 0.1.7 的持久化层在 open/read 时准备 V3→V4 迁移，可能补入
 * interrupted turn/end 并重新编号。始终消费返回的逻辑事件，不读取物理 JSONL。
 */
export declare function inspectPersistedSession(ctx: Context, id: string): Promise<{
    events: readonly SessionEvent[];
    meta: {
        cwd?: string;
    };
}>;
/** agent.followup / steer 接受的用户消息值。 */
export declare function userMessage(text: string): unknown;
/** 折叠会话事件日志为可读消息行（跳过非 user 来源与空消息）。 */
export declare function foldMessages(events: readonly SessionEvent[]): BridgeMessageRow[];
/** 一个已完成的输出段落：一次 assistant step 定型的 assistant/message（turn 中途即可读，无需等整个 turn）。 */
export interface BridgeSegment {
    seq: number;
    time: number;
    turn: number;
    step: number;
    text?: string;
    reasoning?: string;
    toolCalls: string[];
    openTurn: boolean;
}
/** 按已完成输出段落折叠事件日志：每个 assistant/message 割一段，返回 sinceSeq 后的所有段落（事件序）。 */
export declare function segmentsSince(events: readonly SessionEvent[], sinceSeq?: number): BridgeSegment[];
/** 取自 sinceSeq 之后最新一个已完成输出段落（无则 null）。 */
export declare function latestSegmentSince(events: readonly SessionEvent[], sinceSeq?: number): BridgeSegment | null;
/** 实时思维链切片：一个 live 会话当前"进行中"的增量推理与文本。 */
export interface CoTLiveSlice {
    /** 产生该推理的 turn。 */
    turn: number;
    /** 产生该推理的 step。 */
    step: number;
    /** 自最近一条已定型 assistant 消息以来累积的进行中推理文本（reasoning-delta 拼接）。 */
    reasoning: string;
    /** 同窗口累积的进行中文本增量（text-delta 拼接）。 */
    text: string;
    /** 本切片覆盖到的最大事件 seq（供增量轮询记住游标）。 */
    seq: number;
    /** 最近一次事件时间戳。 */
    time: number;
}
/**
 * 对一个 live 会话的事件日志折叠出其"最近推理/文本增量流"。兼容两代日志形状：
 * - dsh 0.1.5 之后：turn 内不再发布独立 chunk 事件，流式增量内嵌在已定型
 *   assistant/message（或未定型 assistant/attempt）事件的 `stream` 记录里
 *   （reasoning-chunks / text-chunks 批量段 + 原始 chunk：reasoning-delta / text-delta）；
 * - 0.1.2-rc 之前：独立的 assistant/chunk 事件（turn 中途即可见、增量，
 *   这正是旧版监控思维链并按规则提前终止所需的粒度）。
 * 两者兼读、取最新一份；无任何增量（会话空闲、或该 provider 不流式推理/无推理）
 * 返回 null，调用方应回落为 foldMessages 里已定型的 message.reasoning。
 * 纯读、无副作用；事件形状不做任何假设，缺失/异常一律安全处理。
 */
export declare function liveReasoningSnapshot(events: readonly SessionEvent[]): CoTLiveSlice | null;
/** 思维链尾巴默认截断上限（字符）。 */
export declare const REASONING_TAIL_LIMIT = 4000;
/**
 * 组装一条受字符上限约束的"思维链尾巴"用于展示/摘要：
 * 优先进行中的 liveReasoning，否则最近已定型的 lastReasoning；
 * 超出上限时截断并附省略标记。两者皆无返回 undefined。
 */
export declare function reasoningTailOf(liveReasoning: string | undefined, lastReasoning: string | undefined, limit?: number): string | undefined;
/**
 * 会话标题：优先 session/title 事件（last-wins，与 UI 一致）；
 * 无标题事件时回落为第一条用户消息（截断 80 字符）。
 */
export declare function titleOf(events: readonly SessionEvent[]): string | undefined;
/** 日志最大事件序号。 */
export declare function maxSeq(events: readonly SessionEvent[]): number;
export interface WaitForReplyOptions {
    session: Session;
    baselineSeq: number;
    timeoutMs: number;
    signal?: AbortSignal;
    requireTurnEnd?: boolean;
    /** true 时等待到 baseline 之后出现一个“新完成的输出段落”（assistant/message），立即返回该段，不等整个 turn。 */
    waitForSegment?: boolean;
}
/**
 * 轮询等待某会话在 baseline 之后出现新的 assistant 回复。
 *
 * 完成条件默认是"出现一条带文本的新 assistant 回复"（即回复可读），而不是
 * 等待 turn/end。实测发现 bridge 通过 agent.followup() 驱动的 turn 在事件流里
 * 不保证产生 turn/end（会一直等满超时），导致"回复早就有了、读取却要等十几二十秒"。
 * 因此默认不再用 turn/end 作门控；需要完整收尾语义时用 requireTurnEnd:true 显式开启，
 * 此时才会等到其后出现 turn/end。
 *
 * 返回的 message：默认是 baseline 之后最新的一条**带文本** assistant 行；整个等待
 * 窗口内没有等到新文本回复时，回落为 baseline 及之前最新的一条带文本回复并置
 * stale:true（绝不把更晚的无文本中间行当回复返回 —— 那正是渲染层打印 "(no text)"
 * 的来源）。segment 模式同理：新段落优先，否则回落既有段落。
 * 超时/中止返回已收集内容；timedOut 表示"本次等待要求的输出未在预算内出现"。
 */
export declare function waitForReply(opts: WaitForReplyOptions): Promise<BridgeWaitResult>;
export interface TargetCwdArgs {
    workspaceId?: string;
    cwd?: string;
}
/**
 * 解析目标工作目录：workspaceId（注册表）> cwd（绝对路径/任意拼写）> 调用者会话 cwd。
 * 跨工作区由 workspaceId / cwd 任意指定实现。
 */
export declare function resolveTargetCwd(ctx: Context, callerCwd: string | undefined, args: TargetCwdArgs): Promise<string>;
/** 会话 id → workspace id（遍历注册表反查，跨全部工作区）。 */
export declare function workspaceBySession(ctx: Context): ReadonlyMap<string, string>;
/** 会话 cwd → workspace id（按路径匹配；无则 undefined）。 */
export declare function workspaceByPath(ctx: Context, cwd: string | undefined): string | undefined;
/**
 * 将会话计入其 cwd 所属的 workspace（镜像 session-controller 的 create /
 * fork 记账：它们创建代理后都会调用 workspace.attachSession）。没有这一步，
 * bridge 直建的新会话不会出现在任何 workspace 组，而是落到 UI 的"未分组"。
 * cwd 无可校验 workspace 时（目录未登记/无法解析）返回 undefined，会话保持
 * 未分组，与 workspace 的既有语义一致；attach 失败只告警、不阻断会话本身。
 * @returns 会话所属 workspace id，无可归属时 undefined。
 */
export declare function attachSessionToWorkspace(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<string | undefined>;
/**
 * 卡住判定（唯一真源，status 渲染与监控 watchdog 共用）：只有 **running** 会话才可能
 * "卡住" —— 空闲/已收尾的会话没有进展是正常状态，不能报 stall。阈值语义为"超过"
 * （严格大于），与工具描述/README 的 "more than stalledMs" 一致。
 */
export declare function isStalled(running: 'running' | 'idle', stalledMs: number | null, thresholdMs: number): boolean;
/** 一次会话监控快照：供"监控线程"判断主任务是否在跑、有无进展、是否卡住。 */
export interface BridgeStatusSnapshot {
    sessionId: string;
    live: boolean;
    running: 'running' | 'idle';
    title?: string;
    cwd?: string;
    workspaceId?: string;
    /** 是否有未闭合的 turn（agent 正在处理一轮）。 */
    openTurn: boolean;
    /** 最新 turn 编号（0 = 尚未开始第一轮）。 */
    lastTurn: number;
    /** 最近一次事件时间戳（无事件为 null）；用于卡住检测。 */
    lastActivityAt: number | null;
    /** 距最近一次事件已过去多少毫秒（now - lastActivityAt）。 */
    stalledMs: number | null;
    /** 是否有待处理输入（inbox 排队中的消息）。 */
    pendingWork: boolean;
    nextTurnCount: number;
    nextStepCount: number;
    /** 最新一条带文本的 assistant 回复。 */
    lastAssistantText?: string;
    /** 最新一条已定型 assistant 消息的推理（reasoning content block）。 */
    lastReasoning?: string;
    /** 进行中的实时思维链增量（reasoning-delta 拼接；无进行中流时为 undefined）。 */
    liveReasoning?: string;
    /** 极紧凑的思维链尾巴：liveReasoning 优先、否则 lastReasoning，截断至 reasoningTailLimit。 */
    reasoningTail?: string;
    /** 折叠后的消息总数。 */
    messageCount: number;
    /** 最近几条消息（默认 8）。 */
    recent: BridgeMessageRow[];
}
/**
 * 计算一个 live 会话的监控快照（agent 状态 + 事件折叠出的进度/卡住事实）。
 * 纯读，无副作用。用于 `session_bridge_status`。
 */
export declare function statusSnapshot(ctx: Context, agent: LiveAgentLike): BridgeStatusSnapshot;
/**
 * 组装 `session_bridge_archived` 的返回条目：只有当标题确实解析出来时才带上
 * `title` 字段。显式写入 `title: undefined` 会让工具返回值不再是 lossless JSON，
 * 宿主会因此拒绝**整个**工具结果（真实事故：归档集合里存在"无用户消息 / 无
 * session/title 事件"的会话时，`resolveTitles: true` 必然报
 * `value is not lossless JSON`）。标题缺失只是信息缺失，不应让工具整体失败。
 */
export declare function archivedEntries(ids: readonly string[], titles: ReadonlyMap<string, string | undefined>): Array<{
    sessionId: string;
    title?: string;
}>;
/** 取 live agent（跨工具/监控共用）。不存在返回 undefined。 */
export declare function getLiveAgent(ctx: Context, sessionId: string): LiveAgentLike | undefined;
/** 对 live 会话发送一条用户消息（queue=追加一轮，steer=打断当前步注入）。 */
export declare function sendLiveMessage(ctx: Context, sessionId: string, message: string, mode: 'queue' | 'steer'): boolean;
/** 中止一个 live 会话的活动 turn（可保留队列输入）。返回是否发起了取消。 */
export declare function cancelLiveSession(ctx: Context, sessionId: string, keepInbox: boolean, reason: string | undefined): boolean;
/**
 * 目标会话是否是**顶层**会话（而不是某个 agent 派生的子代理）。
 *
 * 判据是 dsh-agent 的 `AgentRegistry.roots()`：它返回"创建时没有 owner"的 agent
 * （`entry.owner === undefined`），其注释明确"durable session lineage 不影响该运行时
 * 关系"。桥创建的会话与 UI 主会话都是顶层。
 *
 * 返回 undefined 表示**无法判定**（宿主没有 roots API，例如旧 harness 或测试桩）——
 * 调用方应按顶层处理，保持旧行为，而不是改判成子代理。
 */
export declare function isRootAgent(ctx: Context, sessionId: string): boolean | undefined;
/**
 * 收集某个会话**直接派生**的子代理快照（循环转移时的交接清单用）。
 *
 * 归属判定优先用 `AgentRegistry.isOwnedBy(id, owner)`（`store.get(id)?.owner === owner`，
 * 精确到运行时父子关系，且"运行时归属与持久化谱系无关"）；宿主没有该方法时回落到
 * session header 的 `parentSession`（持久化信息，重启后仍可读，但会把 fork 出来的
 * 会话也算进来，故仅作兜底）。
 *
 * 只读；任何一步异常都不抛出——宁可少列一个子代理，也不能让转移流程失败。
 */
export declare function collectDescendants(ctx: Context, owner: LiveAgentLike): BridgeDescendantInfo[];
