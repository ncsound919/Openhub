/**
 * Generated from shared/llm-mesh/models.json — do not hand-edit.
 *
 * `state: local-ready` means the converted LoRA GGUF is present and deployed
 * with the phone base model. `runtimeModel` is the llama.cpp model alias; the
 * mesh selects `loraIndex` before generation.
 */
export const MODEL_ASSIGNMENT = {
  "appId": "openhub",
  "primary": "qwen-coding-mobile-v2",
  "fallback": "general",
  "privacy": "cloud-allowed",
  "task": "coding",
  "baseModel": "unsloth/Qwen3.5-4B",
  "adapter": "Pulse Daw/kaggle_qwen_coding_mobile/output_v2/qwen_coding_mobile",
  "adapterBytes": 239536272,
  "state": "local-ready",
  "runtimeModel": "qwen3.5-4b",
  "ggufKind": "lora",
  "loraIndex": 1,
  "gguf": "models/qwen-coding-v2.lora.f16.gguf"
} as const;
export type ModelAssignment = typeof MODEL_ASSIGNMENT;
export const MODEL_READY: boolean = String(MODEL_ASSIGNMENT.state) === 'local-ready';
