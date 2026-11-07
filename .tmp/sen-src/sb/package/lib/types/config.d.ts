/**
 * 插件配置（volatile）—— 思维链循环自动中断的开关与全局默认值。
 *
 * 两种开启方式共用这一份配置：
 *  1. 命令 `/cot-loop on|off|status|...`：host 侧写回 profile patch，立即生效；
 *  2. 设置 → Plugins 页该插件的表单：dsh-settings 扫描 Config 里标了 volatile 的字段
 *     自动渲染控件，改完同样写回 profile patch。
 *
 * 字段标 volatile 后由 Loader 解析成**稳定引用**（读 `.get()`）：运行中的守护每次 tick
 * 都读同一个引用，所以开/关不需要重启或热重载插件。
 */
import z from '@deepseek-ai/schemastery';
/** 循环检测看哪一段内容。 */
export declare const LOOP_FIELD_VALUES: readonly ["reasoning", "text", "both"];
/** 转移时对仍在运行的子代理的处置。 */
export declare const LOOP_DESCENDANTS_VALUES: readonly ["report", "stop", "ignore"];
export type LoopFieldValue = (typeof LOOP_FIELD_VALUES)[number];
export type LoopDescendantsValue = (typeof LOOP_DESCENDANTS_VALUES)[number];
/**
 * 配置形状。**必须显式命名，不能靠推导**：`Config` 是导出的（设置页读它、`pnpm smoke`
 * 也断言它），而 `tsc --emitDeclarationOnly` 要为它生成 `.d.ts`——推导出来的类型会引用
 * pnpm 虚拟 store 里的深路径 `.pnpm/@deepseek-ai+schemastery@x.y.z/node_modules/...`，
 * 在**干净安装**（CI/Linux）上直接失败：
 *
 *   src/config.ts(34,14): error TS2742: The inferred type of 'Config' cannot be named
 *   without a reference to '.pnpm/@deepseek-ai+schemastery@3.18.5/...'. This is likely
 *   not portable. A type annotation is necessary.
 *
 * 注意这个错**只在干净安装上出现**：本机 `build.sh` 会在 `node_modules/` 里建 junction
 * 指向本地 dsh checkout，类型解析到稳定路径，于是本地 `pnpm build` 侥幸通过（见 AGENTS.md §2）。
 * 显式标注后 `.d.ts` 里只剩包名 `@deepseek-ai/schemastery`，与官方插件的
 * `export declare const Config: Schema<X>` 写法一致。
 */
export interface PluginConfig {
    loopGuard: boolean;
    loopField: string;
    loopMinCycles: number;
    loopMinRepeats: number;
    loopMinConfidence: number;
    loopMinHits: number;
    loopCooldownMs: number;
    loopMaxTransfers: number;
    loopDescendants: string;
}
/** Cordis config schema：由 profile 的 entry 配置或设置页表单填充。 */
export declare const Config: z<PluginConfig>;
/** 读一个配置值：兼容 Loader 的 volatile 引用与测试里直接传进来的裸值。 */
export declare function readValue<T>(value: unknown): T | undefined;
/** 循环检测的全局默认值：守护没显式传参时用这一份。 */
export interface LoopPolicyDefaults {
    field: LoopFieldValue;
    minCycles: number;
    minRepeats: number;
    minConfidence: number;
    minHits: number;
    cooldownMs: number;
    maxTransfers: number;
    descendants: LoopDescendantsValue;
}
/** 插件级循环策略：总开关 + 全局默认值，两者都**实时**读取（volatile 引用）。 */
export interface LoopPolicy {
    /** 总开关：false 时守护完全跳过循环检测（已存在的守护也立即停手）。 */
    enabled(): boolean;
    /** 内存覆盖值（命令在写不回配置时的退化路径）；undefined = 跟随配置。 */
    override(): boolean | undefined;
    setOverride(next: boolean | undefined): void;
    /** 全局默认值（实时读取，供 monitor_start 未显式传参时使用）。 */
    defaults(): LoopPolicyDefaults;
    /** 配置里是否声明了 loopGuard（供命令提示"配置未加载"）。 */
    hasConfig(): boolean;
}
/** 从插件的 Config 构造循环策略；config 缺失时全部走内置默认值。 */
export declare function createLoopPolicy(config?: unknown): LoopPolicy;
