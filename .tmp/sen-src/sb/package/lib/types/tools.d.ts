/**
 * dsh-session-bridge 模型面向工具：create / send / resume / wait / read / find。
 * 全部经插件宿主 ctx 操作真实 DSH 会话（顶层主会话与任意其它会话）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BridgeRegistry } from './registry.ts';
import type { SessionMonitor } from './monitor.ts';
import type { LoopPolicy } from './config.ts';
export interface BridgeEnv {
    ctx: Context;
    registry: BridgeRegistry;
    monitor: SessionMonitor;
    /** 插件级循环策略（总开关 + 全局默认值）：渲染与默认值都读它。 */
    policy: LoopPolicy;
}
export declare function registerBridgeTools(env: BridgeEnv): void;
