// EcoShorthand v3 — text + binary + batch + wildcards + conditions + temporal + schemas + adaptive dict
// Services: axiom(@a) recourse(@r) dsh(@d) openhub(@o) localjev(@l)

export type Service = "axiom" | "recourse" | "dsh" | "openhub" | "localjev";
export type Op = "?" | "!" | "~" | ">" | "<" | "=" | "+" | "-" | "*" | "&" | "%" | "^" | "@" | "$";
export type Condition = { field: string; op: "==" | "!=" | ">" | "<" | ">=" | "<="; value: string | number };
export type Temporal = { type: "delay" | "interval" | "at" | "every"; value: number | string; unit?: "ms" | "s" | "m" | "h" };

export interface Message {
  src: Service;
  dst: Service | Service[];
  op: Op;
  path: string;
  type?: string;
  args?: (string | number)[];
  meta?: Record<string, string | number>;
  condition?: Condition;
  temporal?: Temporal;
  schema?: string;
  version?: number;
}

const SVC_ID: Record<Service, string> = {
  axiom: "@a", recourse: "@r", dsh: "@d", openhub: "@o", localjev: "@l",
};
const ID_SVC: Record<string, Service> = Object.fromEntries(
  Object.entries(SVC_ID).map(([k, v]) => [v, k as Service])
) as Record<string, Service>;

const TYPE_CODE: Record<string, string> = {
  user: "u", event: "ev", config: "cfg", task: "tsk", job: "job",
  cache: "cch", log: "log", msg: "msg", file: "fil", db: "db",
  session: "ses", token: "tok", hook: "hok", pipe: "pip",
};
const CODE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_CODE).map(([k, v]) => [v, k])
) as Record<string, string>;

const PATH_DICT: Record<string, number> = {
  "user.*": 1, "event.*": 2, "build": 3, "cache": 4, "sync": 5,
  "config": 6, "status": 7, "health": 8, "deploy": 9, "log.tail": 10,
  "user.profile": 11, "event.stream": 12, "task.run": 13, "job.exec": 14,
};
const ARG_DICT: Record<string, number> = {
  "core": 1, "util": 2, "all": 3, "force": 4, "async": 5,
  "sync": 6, "prod": 7, "dev": 8, "v2": 9, "latest": 10,
  "true": 11, "false": 12, "null": 13, "auto": 14, "manual": 15,
};
const DICT_PATH: Record<number, string> = Object.fromEntries(
  Object.entries(PATH_DICT).map(([k, v]) => [v, k])
);
const DICT_ARG: Record<number, string> = Object.fromEntries(
  Object.entries(ARG_DICT).map(([k, v]) => [v, k])
);

const SCHEMA_ID: Record<string, number> = {
  "user:profile": 1, "event:stream": 2, "build:task": 3,
  "cache:entry": 4, "sync:request": 5, "config:update": 6,
  "auth:login": 7, "auth:logout": 8, "data:query": 9, "data:mutate": 10,
};
const ID_SCHEMA: Record<number, string> = Object.fromEntries(
  Object.entries(SCHEMA_ID).map(([k, v]) => [v, k])
);

const SVC_BIN: Record<Service, number> = { axiom: 0, recourse: 1, dsh: 2, openhub: 3, localjev: 4 };
const BIN_SVC: Record<number, Service> = Object.fromEntries(
  Object.entries(SVC_BIN).map(([k, v]) => [v, k as Service])
);
const OP_BIN: Record<Op, number> = { "?": 0, "!": 1, "~": 2, ">": 3, "<": 4, "=": 5, "+": 6, "-": 7, "*": 8, "&": 9, "%": 10, "^": 11, "@": 12, "$": 13 };
const BIN_OP: Record<number, Op> = Object.fromEntries(
  Object.entries(OP_BIN).map(([k, v]) => [v, k as Op])
);

const COND_OP: Record<string, number> = { "==": 0, "!=": 1, ">": 2, "<": 3, ">=": 4, "<=": 5 };
const BIN_COND: Record<number, string> = Object.fromEntries(
  Object.entries(COND_OP).map(([k, v]) => [v, k])
);

const TEMPORAL_TYPE: Record<string, number> = { delay: 0, interval: 1, at: 2, every: 3 };
const BIN_TEMPORAL: Record<number, string> = Object.fromEntries(
  Object.entries(TEMPORAL_TYPE).map(([k, v]) => [v, k])
);

class AdaptiveDict {
  private dict: Record<string, number> = {};
  private reverse: Record<number, string> = {};
  private nextId: number = 100;
  private freq: Record<string, number> = {};

  learn(key: string): number {
    this.freq[key] = (this.freq[key] || 0) + 1;
    if (this.dict[key] !== undefined) return this.dict[key];
    if (this.nextId < 256) {
      this.dict[key] = this.nextId;
      this.reverse[this.nextId] = key;
      this.nextId++;
    }
    return this.dict[key] ?? 0;
  }

  get(key: string): number | undefined { return this.dict[key]; }
  resolve(id: number): string | undefined { return this.reverse[id]; }
  get size(): number { return Object.keys(this.dict).length; }
}

const adaptiveDict = new AdaptiveDict();

export function encode(m: Message): string {
  const parts: string[] = [SVC_ID[m.src], Array.isArray(m.dst) ? m.dst.map((d) => SVC_ID[d]).join("&") : SVC_ID[m.dst], m.op, m.path];
  if (m.type) parts.push(":" + (TYPE_CODE[m.type] ?? m.type));
  if (m.args?.length) parts.push("[" + m.args.join(",") + "]");
  if (m.meta) parts.push("{" + Object.entries(m.meta).map(([k, v]) => `${k}=${v}`).join(",") + "}");
  if (m.condition) parts.push("?" + m.condition.field + m.condition.op + m.condition.value);
  if (m.temporal) parts.push("^" + m.temporal.type + ":" + m.temporal.value + (m.temporal.unit ? m.temporal.unit : ""));
  if (m.schema) parts.push("#" + m.schema);
  if (m.version !== undefined) parts.push("v" + m.version);
  return parts.join("");
}

export function decode(s: string): Message {
  const re = /^(@[ardol])(@[ardol](?:&@[ardol])*)([?!~><=+\-*&%@$^])([^:\[\]{}]+)(?::([a-z]+))?(?:\[([^\]]*)\])?(?:\{([^}]*)\})?(?:\?([^\s]+)(==|!=|>|<|>=|<=)([^\s]+))?(?:\^(\w+):(\d+)(ms|s|m|h)?)?(?:#(\w+))?(v(\d+))?$/;
  const m = s.match(re);
  if (!m) throw new Error(`Parse error: ${s}`);
  const [, srcRaw, dstRaw, op, path, typeCode, argsRaw, metaRaw, condField, condOp, condValue, tempType, tempValue, tempUnit, schema, ver] = m;
  const dst = dstRaw.split("&").map((d) => ID_SVC[d]) as Service | Service[];
  const args = argsRaw?.split(",").filter(Boolean).map((a) => isNaN(Number(a)) ? a : Number(a));
  const meta = metaRaw?.split(",").reduce((acc, kv) => { const [k, v] = kv.split("="); acc[k] = isNaN(Number(v)) ? v : Number(v); return acc; }, {} as Record<string, string | number>);
  const condition = condField ? { field: condField, op: condOp as Condition["op"], value: isNaN(Number(condValue)) ? condValue : Number(condValue) } : undefined;
  const temporal = tempType ? { type: tempType as Temporal["type"], value: Number(tempValue), unit: tempUnit as Temporal["unit"] } : undefined;
  return { src: ID_SVC[srcRaw], dst, op: op as Op, path, type: CODE_TYPE[typeCode] ?? typeCode, args, meta, condition, temporal, schema, version: ver ? Number(ver) : undefined };
}

export function encodeBinary(m: Message): Uint8Array {
  const buf: number[] = [];
  buf.push(SVC_BIN[m.src]);
  if (Array.isArray(m.dst)) {
    buf.push(0x80 | m.dst.length);
    m.dst.forEach((d) => buf.push(SVC_BIN[d]));
  } else {
    buf.push(SVC_BIN[m.dst]);
  }
  buf.push(OP_BIN[m.op]);
  const pathIdx = PATH_DICT[m.path] ?? adaptiveDict.get(m.path);
  if (pathIdx !== undefined && pathIdx !== 0) {
    buf.push(0x80 | pathIdx);
  } else {
    const pathBytes = new TextEncoder().encode(m.path);
    buf.push(pathBytes.length);
    pathBytes.forEach((b) => buf.push(b));
  }
  if (m.type) {
    const typeCode = TYPE_CODE[m.type] ?? m.type;
    const typeBytes = new TextEncoder().encode(typeCode);
    buf.push(typeBytes.length);
    typeBytes.forEach((b) => buf.push(b));
  } else {
    buf.push(0);
  }
  if (m.args?.length) {
    buf.push(m.args.length);
    m.args.forEach((a) => {
      if (typeof a === "number") {
        buf.push(0x80);
        buf.push(a & 0xFF, (a >> 8) & 0xFF);
      } else {
        const argIdx = ARG_DICT[a] ?? adaptiveDict.get(a);
        if (argIdx !== undefined && argIdx !== 0) {
          buf.push(0x80 | argIdx);
        } else {
          const argBytes = new TextEncoder().encode(a);
          buf.push(argBytes.length);
          argBytes.forEach((b) => buf.push(b));
        }
      }
    });
  } else {
    buf.push(0);
  }
  if (m.meta) {
    const metaEntries = Object.entries(m.meta);
    buf.push(metaEntries.length);
    metaEntries.forEach(([k, v]) => {
      const kBytes = new TextEncoder().encode(k);
      buf.push(kBytes.length);
      kBytes.forEach((b) => buf.push(b));
      if (typeof v === "number") {
        buf.push(0x80);
        buf.push(v & 0xFF, (v >> 8) & 0xFF);
      } else {
        const vBytes = new TextEncoder().encode(v);
        buf.push(vBytes.length);
        vBytes.forEach((b) => buf.push(b));
      }
    });
  } else {
    buf.push(0);
  }
  if (m.condition) {
    buf.push(1);
    const fieldBytes = new TextEncoder().encode(m.condition.field);
    buf.push(fieldBytes.length);
    fieldBytes.forEach((b) => buf.push(b));
    buf.push(COND_OP[m.condition.op] ?? 0);
    if (typeof m.condition.value === "number") {
      buf.push(0x80);
      buf.push(m.condition.value & 0xFF, (m.condition.value >> 8) & 0xFF);
    } else {
      const valBytes = new TextEncoder().encode(m.condition.value);
      buf.push(valBytes.length);
      valBytes.forEach((b) => buf.push(b));
    }
  } else {
    buf.push(0);
  }
  if (m.temporal) {
    buf.push(1);
    buf.push(TEMPORAL_TYPE[m.temporal.type] ?? 0);
    if (typeof m.temporal.value === "number") {
      buf.push(0x80);
      buf.push(m.temporal.value & 0xFF, (m.temporal.value >> 8) & 0xFF);
    } else {
      const valBytes = new TextEncoder().encode(m.temporal.value);
      buf.push(valBytes.length);
      valBytes.forEach((b) => buf.push(b));
    }
    const unitMap: Record<string, number> = { ms: 0, s: 1, m: 2, h: 3 };
    buf.push(unitMap[m.temporal.unit || "ms"] ?? 0);
  } else {
    buf.push(0);
  }
  if (m.schema) {
    const schemaIdx = SCHEMA_ID[m.schema];
    if (schemaIdx !== undefined) {
      buf.push(0x80 | schemaIdx);
    } else {
      const schemaBytes = new TextEncoder().encode(m.schema);
      buf.push(schemaBytes.length);
      schemaBytes.forEach((b) => buf.push(b));
    }
  } else {
    buf.push(0);
  }
  if (m.version !== undefined) {
    buf.push(m.version);
  } else {
    buf.push(0);
  }
  const checksum = buf.reduce((sum, b) => sum + b, 0) & 0xFF;
  buf.push(checksum);
  const frame = new Uint8Array(4 + buf.length);
  frame[0] = buf.length & 0xFF;
  frame[1] = (buf.length >> 8) & 0xFF;
  frame[2] = 0x01;
  frame[3] = 0x00;
  frame.set(buf, 4);
  return frame;
}

export function decodeBinary(data: Uint8Array): Message {
  let pos = 4;
  const src = BIN_SVC[data[pos++]];
  const dstFlag = data[pos++];
  let dst: Service | Service[];
  if (dstFlag & 0x80) {
    const count = dstFlag & 0x7F;
    dst = [];
    for (let i = 0; i < count; i++) dst.push(BIN_SVC[data[pos++]]);
  } else {
    dst = BIN_SVC[dstFlag];
  }
  const op = BIN_OP[data[pos++]];
  const pathFlag = data[pos++];
  let path: string;
  if (pathFlag & 0x80) {
    const idx = pathFlag & 0x7F;
    path = DICT_PATH[idx] ?? adaptiveDict.resolve(idx) ?? "unknown";
  } else {
    path = new TextDecoder().decode(data.slice(pos, pos + pathFlag));
    pos += pathFlag;
  }
  const typeLen = data[pos++];
  let type: string | undefined;
  if (typeLen > 0) {
    const typeCode = new TextDecoder().decode(data.slice(pos, pos + typeLen));
    pos += typeLen;
    type = CODE_TYPE[typeCode] ?? typeCode;
  }
  const argCount = data[pos++];
  let args: (string | number)[] | undefined;
  if (argCount > 0) {
    args = [];
    for (let i = 0; i < argCount; i++) {
      const flag = data[pos++];
      if (flag & 0x80) {
        if (flag === 0x80) {
          args.push(data[pos] | (data[pos + 1] << 8));
          pos += 2;
        } else {
          const idx = flag & 0x7F;
          args.push(DICT_ARG[idx] ?? adaptiveDict.resolve(idx) ?? "unknown");
        }
      } else {
        const val = new TextDecoder().decode(data.slice(pos, pos + flag));
        pos += flag;
        args.push(isNaN(Number(val)) ? val : Number(val));
      }
    }
  }
  const metaCount = data[pos++];
  let meta: Record<string, string | number> | undefined;
  if (metaCount > 0) {
    meta = {};
    for (let i = 0; i < metaCount; i++) {
      const kLen = data[pos++];
      const k = new TextDecoder().decode(data.slice(pos, pos + kLen));
      pos += kLen;
      const vFlag = data[pos++];
      if (vFlag & 0x80) {
        if (vFlag === 0x80) {
          meta[k] = data[pos] | (data[pos + 1] << 8);
          pos += 2;
        } else {
          meta[k] = vFlag & 0x7F;
        }
      } else {
        const v = new TextDecoder().decode(data.slice(pos, pos + vFlag));
        pos += vFlag;
        meta[k] = isNaN(Number(v)) ? v : Number(v);
      }
    }
  }
  const hasCondition = data[pos++];
  let condition: Condition | undefined;
  if (hasCondition) {
    const fieldLen = data[pos++];
    const field = new TextDecoder().decode(data.slice(pos, pos + fieldLen));
    pos += fieldLen;
    const condOp = BIN_COND[data[pos++]] ?? "==";
    const valFlag = data[pos++];
    let value: string | number;
    if (valFlag & 0x80) {
      if (valFlag === 0x80) {
        value = data[pos] | (data[pos + 1] << 8);
        pos += 2;
      } else {
        value = valFlag & 0x7F;
      }
    } else {
      const v = new TextDecoder().decode(data.slice(pos, pos + valFlag));
      pos += valFlag;
      value = isNaN(Number(v)) ? v : Number(v);
    }
    condition = { field, op: condOp as Condition["op"], value };
  }
  const hasTemporal = data[pos++];
  let temporal: Temporal | undefined;
  if (hasTemporal) {
    const tType = BIN_TEMPORAL[data[pos++]] ?? "delay";
    const tValFlag = data[pos++];
    let tValue: number | string;
    if (tValFlag & 0x80) {
      if (tValFlag === 0x80) {
        tValue = data[pos] | (data[pos + 1] << 8);
        pos += 2;
      } else {
        tValue = tValFlag & 0x7F;
      }
    } else {
      const v = new TextDecoder().decode(data.slice(pos, pos + tValFlag));
      pos += tValFlag;
      tValue = isNaN(Number(v)) ? v : Number(v);
    }
    const unitMap: Record<number, string> = { 0: "ms", 1: "s", 2: "m", 3: "h" };
    const tUnit = unitMap[data[pos++]] ?? "ms";
    temporal = { type: tType as Temporal["type"], value: tValue, unit: tUnit as Temporal["unit"] };
  }
  const schemaFlag = data[pos++];
  let schema: string | undefined;
  if (schemaFlag & 0x80) {
    schema = ID_SCHEMA[schemaFlag & 0x7F] ?? "unknown";
  } else if (schemaFlag > 0) {
    schema = new TextDecoder().decode(data.slice(pos, pos + schemaFlag));
    pos += schemaFlag;
  }
  const version = data[pos++];
  const checksum = data[pos++];
  return { src, dst, op, path, type, args, meta, condition, temporal, schema, version: version || undefined };
}

export function encodeBatch(messages: Message[]): Uint8Array {
  const payloads = messages.map((m) => {
    const encoded = encodeBinary(m);
    return encoded.slice(4);
  });
  const totalLen = payloads.reduce((sum, p) => sum + 2 + p.length, 0);
  const batch = new Uint8Array(4 + totalLen);
  batch[0] = totalLen & 0xFF;
  batch[1] = (totalLen >> 8) & 0xFF;
  batch[2] = 0x02;
  batch[3] = messages.length;
  let offset = 4;
  payloads.forEach((p) => {
    batch[offset++] = p.length & 0xFF;
    batch[offset++] = (p.length >> 8) & 0xFF;
    batch.set(p, offset);
    offset += p.length;
  });
  return batch;
}

export function decodeBatch(data: Uint8Array): Message[] {
  const count = data[3];
  const messages: Message[] = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const msgLen = data[pos] | (data[pos + 1] << 8);
    pos += 2;
    const frame = new Uint8Array(4 + msgLen);
    frame[0] = msgLen & 0xFF;
    frame[1] = (msgLen >> 8) & 0xFF;
    frame[2] = 0x01;
    frame[3] = 0x00;
    frame.set(data.slice(pos, pos + msgLen), 4);
    messages.push(decodeBinary(frame));
    pos += msgLen;
  }
  return messages;
}

export function tokens(s: string | number): number { return Math.ceil((typeof s === "string" ? s.length : s) / 4); }

const samples: Message[] = [
  { src: "axiom", dst: "recourse", op: "?", path: "user.*", type: "user", condition: { field: "role", op: "==", value: "admin" } },
  { src: "dsh", dst: "openhub", op: "!", path: "build", type: "task", args: ["core", "util"], temporal: { type: "delay", value: 500, unit: "ms" } },
  { src: "openhub", dst: "localjev", op: "~", path: "event.*", type: "event", schema: "event:stream" },
  { src: "recourse", dst: "axiom", op: "+", path: "cache", type: "cache", meta: { ttl: 300 }, version: 2 },
  { src: "axiom", dst: ["recourse", "dsh"], op: "&", path: "sync", temporal: { type: "every", value: 30, unit: "s" } },
];

console.log("=== TEXT MODE v3 ===");
for (const msg of samples) {
  const enc = encode(msg);
  const dec = decode(enc);
  const json = JSON.stringify(msg);
  console.log(`${enc}  [${tokens(enc)} tok vs ${tokens(json)} json tok]`);
  console.log(`  decoded: ${JSON.stringify(dec)}`);
}

console.log("\n=== BINARY MODE v3 ===");
for (const msg of samples) {
  const enc = encodeBinary(msg);
  const dec = decodeBinary(enc);
  const json = JSON.stringify(msg);
  console.log(`${enc.length} bytes [~${tokens(enc.length)} tok vs ${tokens(json)} json tok]`);
  console.log(`  decoded: ${JSON.stringify(dec)}`);
}

console.log("\n=== BATCH MODE v3 ===");
const batch = encodeBatch(samples);
const decodedBatch = decodeBatch(batch);
console.log(`Batch: ${batch.length} bytes for ${samples.length} messages`);
decodedBatch.forEach((m, i) => console.log(`  [${i}] ${JSON.stringify(m)}`));

export function demo(): void {
  console.log("=== ADAPTIVE DICT ===");
  adaptiveDict.learn("custom.path");
  adaptiveDict.learn("custom.arg");
  console.log(`Dict size: ${adaptiveDict.size}`);
  console.log(`custom.path -> ${adaptiveDict.get("custom.path")}`);
  console.log(`custom.arg -> ${adaptiveDict.get("custom.arg")}`);
}

export { adaptiveDict };
