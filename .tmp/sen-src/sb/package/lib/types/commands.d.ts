/**
 * 斜杠命令 `/cot-loop`：在交互式 UI（Web / CLI）里直接开关「思维链循环自动中断」。
 *
 * 与设置页的表单**共用同一份配置**（profile patch 里本插件 entry 的 config）：
 *  - 优先用 `configEditor.edit()` 写回配置 → 持久化，Loader 走 volatile-only 提交，立即生效；
 *  - 宿主没有 configEditor（或写失败）时退化成本进程内存覆盖，并明确告知"仅本次运行有效"。
 *
 * 命令面是**可选**的：`commands` 服务不存在时静默跳过（旧 harness 上插件照常工作，
 * 也不引入新的 peer 依赖——两个服务都用运行时注入探测）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type LoopPolicy } from './config.ts';
/** 本插件在 profile patch 里的 entry id（设置页表单、命令写回都按它定位）。 */
export declare const ENTRY_ID = "dsh-session-bridge";
/** 命令名（小写，注册到 `ctx.commands`）。 */
export declare const COMMAND_NAME = "cot-loop";
/** 命令返回值（dsh-commands 的契约：success 的 text 可省，error 的 text 必须非空）。 */
export interface CommandResult {
    kind: 'success' | 'error';
    text: string;
}
/** 写回插件配置的结果。 */
export interface WriteResult {
    ok: boolean;
    message: string;
}
export interface LoopCommandDeps {
    /** 插件级循环策略（实时读总开关与默认值）。 */
    policy: LoopPolicy;
    /** 把若干配置字段写回 profile patch；宿主无 configEditor 时返回 ok=false。 */
    writeConfig(patch: Record<string, unknown>): Promise<WriteResult>;
}
/**
 * 构造"写回插件配置"的函数：定位本插件的 profile entry，把 patch 合并进它的 config。
 * 拿不到 configEditor 时返回 ok=false，调用方退化到内存开关。
 */
export declare function createConfigWriter(ctx: Context): (patch: Record<string, unknown>) => Promise<WriteResult>;
/** 状态摘要（命令无参数或 `status` 时输出）。 */
export declare function loopCommandStatus(deps: LoopCommandDeps): string;
/**
 * 解析并执行一条 `/cot-loop` 输入。
 * 纯函数形态（只依赖注入进来的 policy 与写回函数），便于直接单测。
 */
export declare function runLoopCommand(rawInput: string, deps: LoopCommandDeps): Promise<CommandResult>;
/** 把 `/cot-loop` 注册进宿主命令面；没有 commands 服务时静默跳过。 */
export declare function registerLoopCommands(ctx: Context, deps: LoopCommandDeps): void;
