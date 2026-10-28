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

// The same for a short piece of data inside a line, such as an event title
// from a calendar file. The label is in the title and read first by screen
// readers. The dotted underline marks it as data.
export function UntrustedInline({ label, text }: { label: string; text: string }) {
  return (
    <span className="untrusted-inline" title={label}>
      <span className="sr-only">{label}: </span>
      {text}
    </span>
  );
}
