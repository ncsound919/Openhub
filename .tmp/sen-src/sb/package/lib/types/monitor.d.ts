import type { Context } from '@deepseek-ai/cordis';
import { type LoopSignal } from './loop-guard.ts';
import type { LoopPolicy } from './config.ts';
import type { BridgeRegistry } from './registry.ts';
export interface MonitorConfig {
    /** 目标主任务会话 id。 */
    sessionId: string;
    /** 轮询间隔（毫秒），默认 10000。 */
    intervalMs: number;
    /** 距最近一次事件超过该毫秒数即视为"卡住"，默认 60000。 */
    stalledMs?: number;
    /** 连续卡住超过多少次后自动 cancel 终止，默认 3。 */
    maxStuckCycles?: number;
    /** 判定为完成后出现的文本关键词（任一命中即视为完成信号）。 */
    doneKeywords: string[];
    /** 卡住时注入的 steer 文本（催办/纠偏），默认催办。 */
    onStallSteer?: string;
    /** 是否用 LLM 判断偏离主题（默认 false，用规则即可）。 */
    useLlm?: boolean;
    /** LLM 判定偏离时的纠正 steer 文本。 */
    onOffTrackSteer?: string;
    /** 监控日志文件路径（缺省 DSH_HOME/super-injector/dsh-session-bridge-monitor.log）。 */
    logFile?: string;
    /** 监控会话的说明，仅用于展示。 */
    label?: string;
    /** 思维链（CoT）规则：对实时推理/文本做 contains/not-contains 匹配，持续命中达 cotMinHits 后触发 steer 或 cancel。 */
    coTRules?: CoTRule[];
    /** 一条规则连续命中多少个 tick 才触发（默认 1 = 立即）。 */
    cotMinHits?: number;
    /** 思维链**循环**守卫：false 关闭（默认开启）。 */
    loopGuard?: boolean;
    /** 循环检测字段：reasoning（默认，实时推理优先）/ text / both。 */
    loopField?: 'reasoning' | 'text' | 'both';
    /** 最小周期数（默认 2）。 */
    loopMinCycles?: number;
    /** 最小重复次数（默认 3）；有效门槛 = max(loopMinCycles, loopMinRepeats)。 */
    loopMinRepeats?: number;
    /** 置信度阈值（默认 0.6）。 */
    loopMinConfidence?: number;
    /** 同一签名连续命中多少个 tick 才触发（默认 1 = 首次命中即触发）。 */
    loopMinHits?: number;
    /** 触发冷却（毫秒，默认 max(intervalMs*2, 30000)）：冷却窗口内同一签名不重复触发。 */
    loopCooldownMs?: number;
    /** 最多转移几次（默认 3）；同时是转移链的深度上限。 */
    loopMaxTransfers?: number;
    /** 是否允许把任务转移到新会话（默认 true）；false = 只中断不转移。 */
    loopTransfer?: boolean;
    /** 转移后是否自动守护新会话（默认 true）。 */
    loopAutoMonitor?: boolean;
    /** 自定义交接提示模板（占位符 {{sessionId}}/{{cwd}}/{{reason}}/{{task}}/{{evidence}}/{{descendants}}）。 */
    loopHandoffPrompt?: string;
    /** 子代理处置：report（默认：登记进交接）/ stop（转移时先终止仍在运行的）/ ignore（完全不管）。 */
    loopDescendants?: 'report' | 'stop' | 'ignore';
    /** 当前转移深度（内部每次转移 +1；达到 loopMaxTransfers 后退化为只中断）。 */
    loopTransferDepth?: number;
}
/** 一条思维链规则：匹配实时链的内容并触发动作。 */
export interface CoTRule {
    /** contains = 匹配内容必须包含 value；not-contains = 必须不含 value。 */
    match: 'contains' | 'not-contains';
    /** 在哪个字段上匹配：reasoning（思维链）/ text（回复文本）/ both（任一）。 */
    field: 'reasoning' | 'text' | 'both';
    /** 匹配的关键词（非空）。 */
    value: string;
    /** 触发动作：cancel 立即终止会话；steer 注入一条用户消息引导。 */
    action: 'steer' | 'cancel';
    /** steer 时的注入文案（缺省用默认催办文案）。 */
    message?: string;
}
/** 一条 CoT 规则的连续命中计数（防单次 tick 误触发 & 防重复触发）。 */
export interface CoTRuleState {
    hits: number;
    lastFiredAt: number | null;
    lastMatch: boolean;
    lastSubject: string;
}
export interface MonitorEntryState {
    config: MonitorConfig;
    startedAt: number;
    lastTickAt: number;
    stuckCount: number;
    lastAction: 'none' | 'steer' | 'cancel' | 'done' | 'lost' | 'offtrack' | 'steady' | 'cot-steer' | 'cot-cancel' | 'loop-cancel' | 'loop-transfer' | 'loop-subagent-cancel';
    lastActionAt: number | null;
    lastNote: string;
    done: boolean;
    cycles: number;
    cot: {
        rules: {
            [key: string]: CoTRuleState;
        };
    };
    /** 思维链循环守卫状态。 */
    loop: LoopGuardState;
}
/** 循环守卫运行期状态（每个被监控会话一份）。 */
export interface LoopGuardState {
    /** 按字段记录命中状态：'reasoning' / 'text' / 'subagent:<id>'。 */
    fields: {
        [key: string]: LoopFieldState;
    };
    /** 已完成的转移记录（同时用作转移次数预算）。 */
    transfers: LoopTransferRecord[];
    /** 上次转移尝试时间：失败后节流重试，避免每个 tick 都去建会话。 */
    lastAttemptAt: number | null;
    /** 因循环被终止的子代理数。 */
    subagentCancels: number;
}
/** 单个字段上的循环命中状态。 */
export interface LoopFieldState {
    /** 上一 tick 的签名（field|period|unit）；签名变化即视为另一个循环，命中计数复位。 */
    signature: string;
    /** 同一签名的连续命中次数。 */
    hits: number;
    /** 上次真正触发（转移/中断）的时间，冷却用。 */
    lastFiredAt: number | null;
    /** 最近一次信号（展示用）。 */
    lastSignal: LoopSignal | null;
}
/** 一次循环转移的记录。 */
export interface LoopTransferRecord {
    at: number;
    from: string;
    to: string;
    reason: string;
    period: number;
    repeats: number;
    confidence: number;
    /** 转移时的转移深度（新会话继承 depth + 1）。 */
    depth: number;
    /** 转移时刻原会话派生的子代理清单。 */
    descendants: Array<{
        id: string;
        status: string;
        task?: string;
    }>;
    /** 本次转移中被主动终止的子代理 id。 */
    stopped: string[];
}
export declare class SessionMonitor {
    private readonly entries;
    private timer;
    private readonly logFile;
    private readonly ctx;
    private readonly registry;
    private readonly policy;
    constructor(ctx: Context, registry: BridgeRegistry, logFile?: string, policy?: LoopPolicy);
    /**
     * 本 tick 是否做循环检测：单次 monitor 参数（loopGuard=false）与插件级总开关
     * （设置页/命令）任意一个关闭即不做。总开关实时读 volatile 引用，所以已运行的守护也立即停手。
     */
    private loopEnabled;
    /** 守护没显式传的 loop* 参数，用插件配置里的全局默认值补齐（参数类改动从下一个 start 生效）。 */
    private applyPolicyDefaults;
    /** 启动对一个会话的监控（幂等：已存在则更新配置）。 */
    start(rawConfig: MonitorConfig): MonitorEntryState;
    /** 启动日志里的循环守卫摘要。 */
    private loopSummary;
    /** 停止对一个会话的监控。返回是否存在。 */
    stop(sessionId: string): boolean;
    /** 全部活动监控快照。 */
    list(): MonitorEntryState[];
    /** 移除所有监控（插件卸载用）。 */
    dispose(): void;
    /** 立即触发一轮扫描（测试/手动）：绕过 interval 节流，强制评估每个活动条目。 */
    tickNow(): Promise<void>;
    private ensureTimer;
    private disposeTimer;
    /**
     * 一轮扫描。force=true 忽略 interval 节流（tickNow 用）。
     * 遍历用快照：循环转移会在 tickEntry 里新增（新会话）与删除（原会话）条目，
     * 直接迭代 Map 会让新条目在同一个 tick 里被重复评估。
     */
    private tick;
    private tickEntry;
    private shouldCancel;
    private doCancel;
    private isDone;
    /**
     * 评估思维链（CoT）规则。规则只对 live 会话有意义：running 时用进行中的
     * reasoning-delta 流，空闲时回落到已定型 lastReasoning。not-contains 规则作用在
     * reasoning 字段时，若该会话本就没有推理（非推理模型/尚未产出），不判定为命中，
     * 避免误 cancel 一个根本不产生思维链的会话。
     * @returns true 表示本 tick 已被某条规则触发并处理（steer/cancel），调用方应 return。
     */
    private evaluateCoTRules;
    /**
     * 思维链循环守卫：目标会话的思维链陷入**序列循环**（同一段内容被反复输出，例如
     * "写。好。Go。写。好。Go。写。好。Go。"）时，中断它并把任务转移到新会话继续；
     * 同时顺带照看它派生的子代理（见 evaluateSubagentLoops）。
     *
     * 只在 running 时评估：空闲会话没有"正在循环"的思维链，而且 loop 检测吃的是
     * 实时推理增量（reasoning-delta），空闲时那份增量为空。
     * @returns true 表示本 tick 已处理（转移或中断），调用方应 return。
     */
    private evaluateLoopGuard;
    /**
     * 把任务转移到新会话：**先建新会话**（带交接提示），确认成功后再中断原会话——
     * 反过来的话，创建失败就变成"任务被中断、且没有任何接续"，那是丢任务。
     * 任一步失败都保持原监控，并按 interval 节流重试。
     */
    private transferToNewSession;
    /**
     * 照看目标会话派生的子代理：某个子代理的思维链陷入循环时，终止**那个子代理**，
     * 并 steer 主会话告知需要重派。
     *
     * 刻意不在这里做转移：子代理被终止不会打断主会话的执行树，而"子代理也各开一个新
     * 会话接续"会与主会话的转移叠加，导致重复劳动与递归级联（每个新会话又派生新子代理）。
     * 默认只查思维链（子代理的产出通常就是它的推理）。
     */
    private evaluateSubagentLoops;
    /** 循环触发但无法/不该转移时：只中断原会话。 */
    private loopCancel;
    /** 子代理会话自身循环被中断后，通知它的父会话（若父仍在 live）。 */
    private notifyParent;
    private hasLlm;
    /** LLM 判定当前状态：'stuck' | 'offtrack' | 'steady'。失败回落 'steady'。 */
    private judgeOffTrack;
    private stopWithLog;
    private log;
    private stderr;
}
