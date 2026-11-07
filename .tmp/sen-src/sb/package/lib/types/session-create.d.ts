import type { Context } from '@deepseek-ai/cordis';
import { type LiveAgentLike, type TargetCwdArgs } from './core.ts';
import type { BridgeRegistry } from './registry.ts';
interface ModelSelectionRef {
    current: {
        provider?: string;
        model?: string;
        reasoningEffort?: string;
    } | undefined;
    assembled?: undefined;
}
/**
 * `@deepseek-ai/dsh-agent` 的 `installModelSelection` 有**两种历史签名**（0.2.2-alpha.3 改了）：
 *
 *  - DSH <= 0.2.1-rc.x：`installModelSelection(agentCtx, selection)` —— 第二参数是一个**可变引用**，
 *    它挂 `agent/request` 瀑布，每次请求都把 `selection.current` 写进请求配置；
 *  - DSH >= 0.2.2-alpha.3：`installModelSelection(agentCtx)` —— 选择权归 `AgentModel` +
 *    `modelSelection` session 投影（`agents.create({ agentOptions })` 是"尚未记录选择时"的路由兜底），
 *    函数只负责安装"模型切换提示"监听；第二参数被忽略。
 *
 * 两条路径都能拿到正确路由（我们**始终**把 provider/model/reasoningEffort 写进 `agentOptions`），
 * 差别只在"要不要额外装那个请求改写钩子"。所以这里按**形参个数**做特性探测：
 * 新宿主上多传的那个参数会被静默忽略，但显式分流能让意图留在代码里，也避免依赖"忽略多余实参"这种巧合。
 */
export type InstallModelSelection = (agentCtx: Context, selection?: ModelSelectionRef) => unknown;
/**
 * 按宿主签名安装模型选择。返回 false 表示没有可用的安装器或安装失败，
 * 调用方据此退回自己的 `agent/request` 兜底钩子（旧宿主上的最后一道保险）。
 */
export declare function installModelSelectionCompat(install: InstallModelSelection | undefined, agentCtx: Context, selection: ModelSelectionRef): boolean;
/** 创建会话时的调用方：模型路由从它的 session 请求头继承，预设从它的 ctx 组合。 */
export interface BridgeSessionCaller {
    ctx: Context;
    session: {
        header: {
            cwd?: string;
        };
        requestHeader?: () => {
            config?: {
                provider?: string;
                model?: string;
                reasoningEffort?: string;
            };
        } | undefined;
    };
}
/** 创建参数：workspaceId/cwd 目标解析 + 可选标题/首条提示/模型覆盖。 */
export interface CreateBridgeSessionOptions extends TargetCwdArgs {
    /** 调用方（工具调用时的当前 agent）；缺省则不做预设组合与模型继承。 */
    caller?: BridgeSessionCaller;
    /** 调用方 cwd（优先于 caller.session.header.cwd，供工具显式传入）。 */
    callerCwd?: string;
    title?: string;
    prompt?: string;
    agentPreset?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    /** 会话 id 前缀（默认 `sb-`）。 */
    idPrefix?: string;
}
export interface CreatedBridgeSession {
    sessionId: string;
    cwd: string;
    workspaceId?: string;
    agent: LiveAgentLike;
    /** 发送 prompt 之前的日志锚点；未发送 prompt 时为 undefined。 */
    baselineSeq?: number;
}
/**
 * 创建一个真实的顶层 DSH 会话（agent + session + workspace 记账 + 桥侧登记），
 * 可选立即投递首条提示。返回的 agent 已是 live agent。
 */
export declare function createBridgeSession(ctx: Context, registry: BridgeRegistry, options: CreateBridgeSessionOptions): Promise<CreatedBridgeSession>;
export {};
