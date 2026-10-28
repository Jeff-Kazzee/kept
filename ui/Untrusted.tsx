// Text shown as data in a labeled box, never as markup or instructions. The
// label comes from the data (see src/domain/untrusted.ts).
export function UntrustedBox({ label, text }: { label: string; text: string }) {
  return (
    <div className="untrusted">
      <div className="label">{label}</div>
      <pre>{text}</pre>
    </div>
  );
}
