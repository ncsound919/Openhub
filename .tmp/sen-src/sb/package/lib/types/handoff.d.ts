import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** 截断上限：够读懂，又不会让交接提示膨胀到挤占新会话的上下文。 */
export declare const TASK_LIMIT = 1200;
export declare const USER_LIMIT = 600;
export declare const ASSISTANT_LIMIT = 800;
export declare const REASONING_LIMIT = 1200;
export declare const DESCENDANT_TASK_LIMIT = 400;
/** 交接提示里最多逐个列出的子代理数，其余折叠为计数。 */
export declare const HANDOFF_DESCENDANT_LIMIT = 5;
/** 从原会话日志里提取的任务上下文。 */
export interface BridgeTaskContext {
    /** 首条用户指令（任务定义）。 */
    task?: string;
    /** 最近几条用户指令（可能含补充/纠偏）。 */
    recentUser: string[];
    /** 最后一条带文本的 assistant 回复。 */
    lastAssistant?: string;
    /** 最后一段思维链（已定型优先，否则取进行中的增量）。 */
    lastReasoning?: string;
}
export interface ExtractTaskContextOptions {
    taskLimit?: number;
    userLimit?: number;
    assistantLimit?: number;
    reasoningLimit?: number;
    /** 取最近几条用户指令（默认 3）。 */
    recentUsers?: number;
}
/**
 * 从事件日志折叠出交接所需的任务上下文。思维链优先取**已定型**的最后一段；
 * 若没有（会话正卡在循环里、最后一段还没定型），回落到进行中的增量流——
 * 循环现场通常正是后者。
 */
export declare function extractTaskContext(events: readonly SessionEvent[], options?: ExtractTaskContextOptions): BridgeTaskContext;
/** 一个子代理在转移时刻的快照（清单项，不是完整输出）。 */
export interface BridgeDescendantInfo {
    id: string;
    status: 'running' | 'idle';
    running: boolean;
    origin?: 'subagent';
    delegationDepth?: number;
    /** 该子代理的首条用户指令（它领到的任务）。 */
    task?: string;
}
export interface HandoffPromptInput {
    /** 原会话 id（被中断的那个）。 */
    sessionId: string;
    /** 工作目录。 */
    cwd: string;
    /** 中断原因（人类可读，含周期/重复次数/置信度）。 */
    reason: string;
    context: BridgeTaskContext;
    /** 原会话派生的子代理。 */
    descendants?: readonly BridgeDescendantInfo[];
    /** 本次转移中被主动终止的子代理 id（loopDescendants: 'stop'）。 */
    stopped?: readonly string[];
    /** 自定义模板；缺省用 DEFAULT_HANDOFF_TEMPLATE。占位符见该常量。 */
    template?: string;
}
/** 内置交接模板。占位符：{{sessionId}} {{cwd}} {{reason}} {{task}} {{evidence}} {{descendants}}。 */
export declare const DEFAULT_HANDOFF_TEMPLATE: string;
/**
 * 渲染交接提示。子代理分三类给出不同指令：仍在跑的**不要重做**（去读它的结果）、
 * 被终止的按原分工重派、已结束的直接读结果。空段落整段省略。
 */
export declare function buildHandoffPrompt(input: HandoffPromptInput): string;
