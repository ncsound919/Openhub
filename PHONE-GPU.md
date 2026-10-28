# Qwen 3.5 4B on the phone GPU

Verified 2026-10-26 in Termux without root on a Galaxy S25 Ultra
(`SM-S938U`, Snapdragon 8 Elite, Adreno 830, Android 17).

## Result

| Workload | CPU | Adreno 830 (OpenCL) |
| --- | --- | --- |
| 4B Q4_K_M prefill, 4,001-token prompt | 13–19 tok/s | **97 tok/s** |
| 4B decode | 5.7 tok/s | **11–15 tok/s** |
| Real OpenHub mission, 7,840-token prefill | ~15 min | **130 s** |

All 33/33 layers were offloaded (2.57 GB device buffer), output was coherent,
and missions run from the phone UI wrote their files and reached `DONE`.

## Why OpenCL and not Vulkan

llama.cpp's Vulkan backend sees no device on this phone: the Qualcomm
`libvulkan.so` in `/vendor/lib64` exposes no Adreno ICD to apps, so
`vkEnumeratePhysicalDevices` fails. A Turnip driver would need root/flashing.

OpenCL works once the Adreno driver is copied out of `/vendor/lib64` into app
storage. Termux's linker namespace hides vendor libraries, and Qualcomm's
Khronos ICD loader honours `OCL_ICD_VENDORS`, so the staged driver is visible
to `llama-server --list-devices` as `GPUOpenCL: QUALCOMM Adreno(TM) 830`.

## Files on the phone

- `~/models/Qwen3.5-4B-Q4_K_M.gguf` — 2.5 GB model.
- `~/opencl_adreno.sh` — stages `libOpenCL_adreno.so` and its dependency
  closure in `$PREFIX/lib/opencl-adreno`, writes `~/opencl-icd/adreno.icd`, and
  prints the detected devices. System/bionic libraries are never shadowed.
- `~/start_local_llm_gpu.sh` — starts `llama-server` on `127.0.0.1:8080` with
  all layers offloaded (`-ngl 99`) to the staged OpenCL device, alias
  `qwen3.5-4b`, 16k context, q8_0 KV cache, and waits for `/v1/models`.
- `~/start_local_llm_cpu.sh` — CPU fallback on the same port.
- `~/start_engine_supervisor.sh` — starts opencode through OpenHub's own
  launcher with the local provider configured, and stays alive so the engine's
  exit handler does not tear it down.
- `~/openhub/.env` — `OPENHUB_LOCAL_LLM_URL=http://127.0.0.1:8080` and
  `OPENHUB_LOCAL_LLM_MODEL=qwen3.5-4b`.

The model server's log is `~/llama-server.log`; the engine supervisor's is
`~/engine-supervisor.log`.

## Start and restart

Start the model first, then the engine, so the local provider is registered at
engine startup:

```bash
~/start_local_llm_gpu.sh
~/start_engine_supervisor.sh
```

Check both:

```bash
curl -s http://127.0.0.1:8080/v1/models
curl -s http://127.0.0.1:3000/api/health
```

`~/opencl_adreno.sh` only needs rerunning after a driver or firmware update.

## Limits

- No Vulkan path on this device without root.
- 16k context with a q8_0 KV cache is the tested setting; larger contexts are
  untested and leave little device-memory headroom.
- The server runs one slot (`--parallel 1`), so simultaneous missions queue.

## UI status fix

A mission could remain `RUNNING` after the model finished when the SSE idle
event was missed. `useMission` now reconciles status from the session's final
assistant message during telemetry polling, covered by
`tests/useMission.test.ts`.
