const chipStyle = (active: boolean) =>
  ({
    borderColor: active ? "rgba(237,236,236,0.14)" : "var(--border)",
    color: active ? "var(--text)" : "var(--text-tertiary)",
    background: active ? "rgba(255, 255, 255, 0.04)" : "var(--surface)",
  }) as const;

export function ToolbarTag({
  children,
  active = false,
  onClick,
  ariaLabel,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const className =
    "inline-flex items-center rounded-sm border px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] transition-[border-color,background-color,color]";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-pressed={active}
        className={`${className} cursor-pointer hover:[color:var(--text)]`}
        style={chipStyle(active)}
      >
        {children}
      </button>
    );
  }

  return (
    <span className={className} style={chipStyle(active)}>
      {children}
    </span>
  );
}
