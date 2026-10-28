/**
 * Generated from shared/llm-mesh/models.json — do not hand-edit.
 *
 * `state: adapter-only` means the trained LoRA adapter is present but there is
 * no merged/quantized GGUF in this checkout. Use `runtimeModel` for the local
 * lane; never claim the fine-tune is active on device until the state is
 * `local-ready`.
 */
export const MODEL_ASSIGNMENT = {
  "appId": "openhub",
  "primary": "qwen-coding-mobile-v2",
  "fallback": "general",
  "privacy": "cloud-allowed",
  "task": "coding",
  "baseModel": "unsloth/Qwen2.5-Coder-3B-Instruct-bnb-4bit",
  "adapter": "Pulse Daw/kaggle_qwen_coding_mobile/output_v2/qwen_coding_mobile",
  "adapterBytes": 239536272,
  "state": "adapter-only",
  "runtimeModel": "qwen3.5-4b",
  "gguf": null
} as const;
export type ModelAssignment = typeof MODEL_ASSIGNMENT;
export const MODEL_READY: boolean = String(MODEL_ASSIGNMENT.state) === 'local-ready';
