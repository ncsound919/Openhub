/**
 * dsh-session-bridge host half: 注册会话桥工具
 * (create / send / resume / wait / read / find / status / cancel / monitor_* )，
 * 让当前 agent 能通过提示词创建主会话、向任意会话发消息、等待 / 读取回复、
 * 跨工作区查找会话，以及作为"监控 worker"对主任务会话做后台守护 —
 * 轮询进度、卡住则 steer 催办/纠偏、卡住过久则 cancel 终止、完成即收尾。
 * 监控守护循环是插件自身的组件（见 monitor.ts），非独立插件。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
/** 插件配置：思维链循环自动中断的开关与全局默认值（设置页表单与 /cot-loop 共用同一份）。 */
export { Config };
/** Plugin identity for cordis rows. */
export declare const name = "dsh-session-bridge";
/** Services required before mounting. */
export declare const inject: string[];
/** Host plugin body. */
export declare function apply(ctx: Context, config?: unknown): void;
