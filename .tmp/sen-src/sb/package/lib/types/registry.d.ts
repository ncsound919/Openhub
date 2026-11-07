export interface BridgeRecord {
    sessionId: string;
    title?: string;
    cwd?: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    createdAt: number;
    updatedAt: number;
    lastActivityAt?: number;
    source: 'create' | 'resume' | 'discover';
}
export declare class BridgeRegistry {
    private records;
    private loaded;
    /** 加载登记表（幂等）。 */
    load(): Promise<void>;
    /** 读取快照（自动加载，best-effort）。 */
    get(sessionId: string): Promise<BridgeRecord | undefined>;
    /** 全部记录（自动加载；返回顺序=登记顺序）。 */
    all(): Promise<BridgeRecord[]>;
    /** 新增 / 更新一条记录并落盘（best-effort，不阻塞调用方）。 */
    record(input: {
        sessionId: string;
        title?: string;
        cwd?: string;
        workspaceId?: string;
        provider?: string;
        model?: string;
        source: 'create' | 'resume' | 'discover';
    }): void;
    /** 上报一次活动（发消息 / 等待 / 读取）。永不覆盖登记的别名 title。 */
    touch(sessionId: string, fields?: {
        cwd?: string;
        workspaceId?: string;
    }): void;
    /** 落盘（best-effort）。 */
    persist(): Promise<void>;
}
