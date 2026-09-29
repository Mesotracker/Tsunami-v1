import React, { useEffect, useRef, useState } from "react";



export function Panel({
  title,
  children,
  right,
  collapsible,
  defaultOpen = true,
  dense,
}: {
  title: string;
  children?: React.ReactNode;
  right?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  dense?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border border-[#3a3d42] bg-[#191b1e] mb-1.5">
      <header
        className="flex items-center justify-between px-2 py-1 bg-gradient-to-b from-[#2b2e32] to-[#212427] border-b border-[#4a4e54] select-none"
        onClick={() => collapsible && setOpen(!open)}
        style={{ cursor: collapsible ? "pointer" : "default" }}
      >
        <h3 className="text-[10px] tracking-[0.18em] font-semibold text-[#c69063] uppercase">
          {collapsible ? (open ? "▾ " : "▸ ") : ""}
          {title}
        </h3>
        <div className="flex items-center gap-1">{right}</div>
      </header>
      {open && <div className={dense ? "p-1" : "p-2"}>{children}</div>}
    </section>
  );
}

export function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-2 py-[2px]" title={hint}>
      <label className="text-[10px] uppercase tracking-wider text-[#8d9298] w-[92px] shrink-0 truncate">
        {label}
      </label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

export function NumField({
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
  width = "w-full",
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  width?: string;
}) {
  const [txt, setTxt] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTxt(fmtNum(value));
  }, [value]);
  return (
    <div className={`flex items-center ${width}`}>
      <input
        aria-label={unit ? `value in ${unit}` : "value"}
        className="bg-[#0f1113] border border-[#4a4e54] focus:border-[#b5763c] outline-none text-[11px] text-[#e6e1d8] px-1 py-[2px] w-full font-mono tabular-nums"
        value={txt}
        inputMode="decimal"
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onChange(clampv(value + step));
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onChange(clampv(value - step));
          }
          e.stopPropagation();
        }}
      />
      {unit && <span className="text-[9px] text-[#7d8288] ml-1 shrink-0">{unit}</span>}
    </div>
  );
  function clampv(v: number) {
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    return v;
  }
  function commit() {
    const v = parseFloat(txt.replace(/,/g, ""));
    if (isFinite(v)) onChange(clampv(v));
    else setTxt(fmtNum(value));
  }
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  unit,
  hint,
  log,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  log?: boolean;
}) {
  const toSlider = (v: number) =>
    log ? (Math.log(Math.max(v, min)) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min);
  const fromSlider = (t: number) =>
    log ? Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min))) : min + t * (max - min);
  return (
    <div className="py-[2px]" title={hint}>
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wider text-[#8d9298] w-[92px] shrink-0 truncate">
          {label}
        </label>
        <input
          type="range"
          aria-label={label}
          className="flex-1 tsu-range"
          min={0}
          max={1}
          step={0.001}
          value={Math.min(1, Math.max(0, toSlider(value)))}
          onChange={(e) => {
            const v = fromSlider(parseFloat(e.target.value));
            onChange(step >= 1 ? Math.round(v) : Math.round(v / step) * step);
          }}
        />
        <div className="w-[76px] shrink-0">
          <NumField value={value} onChange={onChange} step={step} min={min} max={max} unit={unit} />
        </div>
      </div>
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label?: string;
}) {
  return (
    <select
      aria-label={label ?? "select"}
      className="w-full bg-[#0f1113] border border-[#4a4e54] focus:border-[#b5763c] outline-none text-[11px] text-[#e6e1d8] px-1 py-[2px]"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      title={hint}
      onClick={() => onChange(!value)}
      className="flex items-center gap-2 w-full py-[2px] text-left group"
    >
      <span
        className={`w-7 h-[13px] border relative transition-colors ${
          value ? "bg-[#7d4a28] border-[#c69063]" : "bg-[#15171a] border-[#4a4e54]"
        }`}
      >
        <span
          className={`absolute top-[1px] w-[11px] h-[9px] transition-all ${
            value ? "left-[15px] bg-[#e8c49a]" : "left-[1px] bg-[#6a6f75]"
          }`}
        />
      </span>
      <span className="text-[10px] uppercase tracking-wider text-[#8d9298] group-hover:text-[#c8ccd1]">
        {label}
      </span>
      <span className="ml-auto text-[9px] font-mono text-[#5f646a]">{value ? "ON" : "OFF"}</span>
    </button>
  );
}

export function Btn({
  children,
  onClick,
  active,
  danger,
  disabled,
  title,
  wide,
  small,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  wide?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        "border font-medium uppercase tracking-[0.12em] transition-colors select-none",
        small ? "text-[9px] px-1.5 py-[2px]" : "text-[10px] px-2 py-[3px]",
        wide ? "w-full" : "",
        disabled
          ? "border-[#33363a] text-[#55595e] bg-[#161819] cursor-not-allowed"
          : active
          ? "border-[#c69063] bg-[#6d431f] text-[#f3dcc0]"
          : danger
          ? "border-[#7a3b33] bg-[#241a19] text-[#d79a8f] hover:bg-[#3a221e]"
          : "border-[#565b61] bg-[#23262a] text-[#cfd3d7] hover:bg-[#2e3237] hover:border-[#8a6a4a]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex border-b border-[#4a4e54] bg-[#141618] overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-2 py-1 text-[10px] tracking-[0.14em] uppercase border-r border-[#2c2f33] whitespace-nowrap ${
            value === t.id
              ? "bg-[#2b2118] text-[#e2b07a] border-b-2 border-b-[#b5763c] -mb-px"
              : "text-[#868b91] hover:text-[#c8ccd1] hover:bg-[#1d2023]"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Readout({
  label,
  value,
  unit,
  accent,
  mono = true,
}: {
  label: string;
  value: string | number;
  unit?: string;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-1 py-[2px] odd:bg-[#16181b]">
      <span className="text-[9px] uppercase tracking-wider text-[#80858b] truncate">{label}</span>
      <span
        className={`${mono ? "font-mono tabular-nums" : ""} text-[11px] ${
          accent ? "text-[#e2b07a]" : "text-[#dfe2e5]"
        }`}
      >
        {value}
        {unit && <span className="text-[9px] text-[#7d8288] ml-0.5">{unit}</span>}
      </span>
    </div>
  );
}

export function fmtNum(v: number): string {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "e9";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.001) return v.toFixed(3);
  return v.toExponential(2);
}

export function fmtTime(t: number, precise = false): string {
  if (!isFinite(t) || t < 0) return precise ? "00:00:00.00" : "—";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (precise)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
  return `${h > 0 ? h + ":" : ""}${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
}

export function fmtBytes(b: number) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b > 1e6) return (b / 1e6).toFixed(1) + " MB";
  if (b > 1e3) return (b / 1e3).toFixed(0) + " KB";
  return b + " B";
}

export function fmtDist(m: number, imperial = false) {
  if (imperial) {
    const ft = m * 3.28084;
    if (ft > 5280) return (ft / 5280).toFixed(2) + " mi";
    return ft.toFixed(0) + " ft";
  }
  if (Math.abs(m) >= 1000) return (m / 1000).toFixed(2) + " km";
  return m.toFixed(0) + " m";
}
