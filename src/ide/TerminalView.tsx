import React from 'react';
import { Terminal as XtermTerminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { Loader2, WifiOff } from 'lucide-react';

/** Read the live theme tokens so the terminal follows light/dark instead of
 *  staying hardcoded dark. Falls back to the dark defaults if unset. */
function readTermTheme(): { background: string; foreground: string; cursor: string } {
  const cs = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const bg = cs?.getPropertyValue('--color-bg-base').trim();
  const fg = cs?.getPropertyValue('--color-text-primary').trim();
  const accent = cs?.getPropertyValue('--color-accent').trim();
  return { background: bg || '#0b0c0e', foreground: fg || '#e9ebee', cursor: accent || '#5e6ad2' };
}

/** Real shell bridge. Connects to /ws/terminal, streams to xterm. */
export function TerminalView({ projectRepoId }: { projectRepoId: string }) {
  const holderRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<XtermTerminal | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting');

  React.useEffect(() => {
    if (!holderRef.current) return;
    const term = new XtermTerminal({
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      convertEol: true,
      theme: readTermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holderRef.current);
    termRef.current = term;

    // Cookie-auth the socket: the browser sends the HttpOnly accessToken cookie
    // on the WS upgrade, so no token belongs in the URL.
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws/terminal`;
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(url);
    } catch {
      setStatus('error');
      return;
    }
    socketRef.current = socket;
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      setStatus('connected');
      term.writeln('\x1b[90mOpenHub terminal — connected to active project.\x1b[0m');
    };
    socket.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      term.write(data);
    };
    socket.onclose = (ev) => {
      setStatus(ev.code === 1000 ? 'closed' : 'error');
      term.writeln(`\r\n\x1b[31m[connection closed: ${ev.code} ${ev.reason}]\x1b[0m`);
    };
    socket.onerror = () => {
      setStatus('error');
      term.writeln('\r\n\x1b[31m[terminal error — is the server running?]\x1b[0m');
    };

    const onData = term.onData((data) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    const resize = () => {
      try {
        fit.fit();
      } catch { /* hidden */ }
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (holderRef.current) ro.observe(holderRef.current);

    // Follow theme switches (data-theme on <html>) without remounting xterm.
    const themeObserver = new MutationObserver(() => { term.options.theme = readTermTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      onData.dispose();
      try {
        socket?.close();
      } catch { /* noop */ }
      term.dispose();
      socketRef.current = null;
      termRef.current = null;
    };
  }, [projectRepoId]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-base)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-muted)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        Terminal
        <span className="ml-auto flex items-center gap-1 font-mono normal-case tracking-normal">
          {status === 'connecting' && <><Loader2 className="w-3 h-3 animate-spin" /> connecting</>}
          {status === 'connected' && <span className="text-[var(--color-success)]">● live</span>}
          {status === 'closed' && <span className="text-[var(--color-text-muted)]">○ closed</span>}
          {status === 'error' && <span className="flex items-center gap-1 text-[var(--color-danger)]"><WifiOff className="w-3 h-3" /> error</span>}
        </span>
      </div>
      <div ref={holderRef} className="min-h-0 flex-1 p-1" />
    </div>
  );
}