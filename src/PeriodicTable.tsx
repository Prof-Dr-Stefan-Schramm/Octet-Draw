// The periodic table window (View > Show or Hide Periodic Table, the command palette, and the table button after the
// Actions panel's element chips), as ChemDraw's Periodic Table window. Its layout is ReShiki's (periodic.ts). A click on
// an element sets the selected atoms to it; with no atom selected it is held for the Text tool (the editor's onPick says
// which, and the line under the table says so). Open until it is closed.
//
// Keyboard: the window takes the focus when it opens. The arrow keys move through the grid, Home and End go to the ends
// of the row, a typed symbol goes to that element, Return or Space picks it, and Escape closes the window.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useLeaving } from "./motion";
import { capital, cellOf, elementInfo, findSymbol, PERIODIC_ROWS, ROW_NAMES, step } from "./periodic.ts";

const HINT = "Select atoms, then choose an element. Or choose one to add with the Text tool.";
// current: the element to mark (the selected atoms' own, else the one held); held: the element the Text tool holds.
export function PeriodicTable({ current, held, onPick, onClose }: { current?: string; held?: string; onPick: (symbol: string) => string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null), leaving = useLeaving();
  // The element the arrow keys move from (the one button in the tab order), the one under the pointer, and what the last
  // pick did.
  const [focus, setFocus] = useState(() => (current && cellOf(current)) || cellOf("C")!);
  const [shown, setShown] = useState<string>(), [note, setNote] = useState(HINT);
  // An element let go (another tool taken) takes its line away.
  const wasHeld = useRef(held);
  useEffect(() => { if (wasHeld.current && !held) setNote(HINT); wasHeld.current = held; }, [held]);
  const typed = useRef({ text: "", at: 0 });
  const button = (at: [number, number]) => box.current?.querySelector<HTMLButtonElement>(`[data-cell="${at[0]}-${at[1]}"]`);
  useLayoutEffect(() => { button(focus)?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (at: [number, number]) => { setFocus(at); button(at)?.focus({ preventScroll: true }); };
  // Escape closes the window from anywhere in it.
  useEffect(() => {
    if (leaving) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !box.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    addEventListener("keydown", esc, true);
    return () => removeEventListener("keydown", esc, true);
  }, [leaving, onClose]);
  const keys = (e: React.KeyboardEvent) => {
    // The drawing takes no keys from the window (an arrow key would move the selection), but the menu keys go on.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.stopPropagation();
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      // From the button with the focus (two keys can come before the window draws again).
      const cell = (e.target as HTMLElement).dataset?.cell?.split("-").map(Number) as [number, number] | undefined;
      return go(step(cell?.length === 2 ? cell : focus, e.key as Parameters<typeof step>[1]));
    }
    // Letters go to the element with that symbol: F is fluorine, F then e (within a second) iron.
    if (/^[a-z]$/i.test(e.key)) {
      e.preventDefault();
      const now = performance.now();
      let text = now - typed.current.at < 1000 ? typed.current.text + e.key : e.key, found = findSymbol(text);
      if (!found) { text = e.key; found = findSymbol(text); }
      typed.current = { text, at: now };
      const at = found && cellOf(found);
      if (at) go(at);
    }
  };
  const pick = (symbol: string, at: [number, number]) => { setFocus(at); setNote(onPick(symbol)); };
  const info = elementInfo(shown ?? PERIODIC_ROWS[focus[0]][focus[1]]);
  return (
    <div ref={box} className={["page-menu periodic-table", leaving && "leaving"].filter(Boolean).join(" ")} role="dialog" aria-label="Periodic table" inert={leaving}
      onMouseDown={(e) => e.preventDefault()} onKeyDown={keys}>
      <div className="periodic-head">
        <h3>Periodic table</h3>
        <button className="actions-close" aria-label="Close periodic table" data-tip="Close periodic table" onClick={onClose}><X size={12} /></button>
      </div>
      <div className="periodic-grid" onMouseLeave={() => setShown(undefined)}>
        {PERIODIC_ROWS.map((row, r) => (
          <div key={r} className={r === 7 ? "periodic-row f-block" : "periodic-row"} role="group" aria-label={ROW_NAMES[r]}>
            {row.map((symbol, c) => {
              if (!symbol) return <span key={c} aria-hidden />;
              const el = elementInfo(symbol)!, on = focus[0] === r && focus[1] === c;
              return (
                <button key={c} className="chip element" data-cell={`${r}-${c}`} tabIndex={on ? 0 : -1} aria-pressed={symbol === current}
                  aria-label={`${capital(el.name)}, ${el.number}`} onClick={() => pick(symbol, [r, c])}
                  onMouseEnter={() => setShown(symbol)} onFocus={() => setFocus([r, c])}>
                  {symbol}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="periodic-info" aria-hidden>
        {info && <><span className="periodic-number">{info.number}</span><strong>{info.symbol}</strong><span>{capital(info.name)}</span>
          {info.mass !== undefined && <span className="periodic-number">{info.mass.toFixed(3)}</span>}</>}
      </div>
      <p className="periodic-note" role="status">{note}</p>
    </div>
  );
}
