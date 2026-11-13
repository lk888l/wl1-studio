import { useEffect, useRef, useState } from "react";

// Keep text local while typing (including empty/partial numeric input). Device
// acknowledgements update the display only after editing has finished.
export function KnobNumberInput({ value, onChange, onCommit, ...props }: {
  value: number; onChange: (value: number) => void; onCommit?: (delay?: number) => void;
  "aria-label": string; id?: string; min?: number; max?: number; step?: number; disabled?: boolean;
}) {
  const display = Number.isFinite(value) ? String(Number(value.toPrecision(8))) : "";
  const [text, setText] = useState(display);
  const focused = useRef(false), stepping = useRef(false);
  useEffect(() => { if (!focused.current) setText(display); }, [display]);
  return <input {...props} type="number" value={text}
    onFocus={() => { focused.current = true; }}
    onBlur={() => { focused.current = false; stepping.current = false; onCommit?.(); setText(display); }}
    onKeyDown={event => {
      stepping.current = event.key === "ArrowUp" || event.key === "ArrowDown";
      if (event.key === "Enter") { event.preventDefault(); onCommit?.(); }
    }}
    onKeyUp={() => { stepping.current = false; }}
    onChange={event => {
      setText(event.target.value);
      onChange(event.target.value === "" ? Number.NaN : Number(event.target.value));
      const inputType = (event.nativeEvent as InputEvent).inputType;
      if (stepping.current || !inputType) onCommit?.(150);
    }} />;
}
