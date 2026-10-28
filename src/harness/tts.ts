/**
 * Kokoro loopback bridge. The browser talks to OpenHub, never to :8770
 * directly, so an HTTPS OpenHub deployment does not hit mixed-content rules.
 */

export interface TtsResult {
  ok: boolean;
  status: number;
  audio?: Uint8Array;
  contentType?: string;
  error?: string;
}

export async function fetchTts(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TtsResult> {
  const url = (env.KOKORO_TTS_URL || 'http://127.0.0.1:8770/tts').trim();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { reason?: string; error?: string }
        | null;
      return {
        ok: false,
        status: response.status,
        error: body?.reason || body?.error || `Kokoro returned HTTP ${response.status}`,
      };
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.length === 0) {
      return { ok: false, status: 503, error: 'Kokoro returned an empty audio file.' };
    }
    return {
      ok: true,
      status: response.status,
      audio,
      contentType: response.headers.get('content-type') || 'audio/wav',
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: `Kokoro is unreachable on the loopback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
