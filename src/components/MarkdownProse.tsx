import React from 'react';

/**
 * A small, dependency-free markdown renderer for reporter dispatches.
 * Handles headings, bold/italic, inline code, bullet and numbered lists,
 * blockquotes, tables, horizontal rules, and paragraphs. It intentionally does
 * not handle raw HTML — reporter output is trusted plain markdown, but links and
 * images are rendered as text so nothing is injected.
 */

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|_([^_]+)_|\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[2] !== undefined) nodes.push(<strong key={key} className="font-semibold text-[var(--color-text-primary)]">{m[2]}</strong>);
    else if (m[3] !== undefined) nodes.push(<code key={key} className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-[0.85em]">{m[3]}</code>);
    else nodes.push(<em key={key} className="text-gray-300">{m[4] ?? m[5]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function headingClass(level: number): string {
  if (level <= 1) return 'text-xl font-extrabold tracking-tight text-[var(--color-text-primary)]';
  if (level === 2) return 'mt-1 text-sm font-extrabold uppercase tracking-[0.14em] text-cyan-300';
  return 'text-xs font-bold uppercase tracking-[0.12em] text-gray-300';
}

export function MarkdownProse({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${key++}`} className="my-4 border-border-muted" />);
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], `h-${key}`);
      if (level <= 1) blocks.push(<h1 key={`h-${key++}`} className={`${headingClass(level)} leading-snug`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`h-${key++}`} className={`${headingClass(level)} mt-2`}>{content}</h2>);
      else blocks.push(<h3 key={`h-${key++}`} className={headingClass(level)}>{content}</h3>);
      i++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!/^[-: ]+$/.test(cells.join(''))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={`table-${key++}`} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr>
                {head?.map((c, ci) => (
                  <th key={ci} className="border-b border-border-muted px-2 py-1.5 text-left font-mono font-bold uppercase tracking-wide text-gray-400">{inline(c, `th-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className="odd:bg-surface-base/40">
                  {row.map((c, ci) => (
                    <td key={ci} className="border-b border-border-muted/50 px-2 py-1.5 text-gray-300">{inline(c, `td-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="my-2 space-y-1">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2 text-sm leading-relaxed text-gray-300">
              <span className="mt-[0.35rem] h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/70" />
              <span>{inline(it, `li-${ii}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="my-2 list-decimal space-y-1 pl-5 text-sm text-gray-300">
          {items.map((it, ii) => <li key={ii}>{inline(it, `oli-${ii}`)}</li>)}
        </ol>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={`bq-${key++}`} className="my-2 border-l-2 border-cyan-500/40 pl-3 text-sm italic text-gray-400">
          {items.map((it, ii) => <p key={ii}>{inline(it, `bq-${ii}`)}</p>)}
        </blockquote>,
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*---+\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={`p-${key++}`} className="text-sm leading-relaxed text-gray-300">{inline(para.join(' '), `p-${key}`)}</p>);
  }

  return <div className={`space-y-2 ${className}`}>{blocks}</div>;
}
