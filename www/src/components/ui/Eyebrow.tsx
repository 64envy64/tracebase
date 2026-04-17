export function Eyebrow({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p
      id={id}
      className="text-xs font-light tracking-widest uppercase"
      style={{ color: "var(--text-tertiary)" }}
    >
      {children}
    </p>
  );
}
