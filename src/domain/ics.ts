// Small .ics reader. It reads VEVENT blocks and keeps DTSTART, DTEND, SUMMARY
// and UID. Times stay as wall-clock values with their TZID. It does not
// expand RRULE, so a recurring event shows only its first instance and is
// flagged. Runs in the browser and in Node.

export type IcsTime = {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM, null for an all-day value
  tzid: string | null;
  utc: boolean;
};

export type IcsEvent = {
  uid: string | null;
  summary: string;
  start: IcsTime;
  end: IcsTime | null;
  recurring: boolean;
};

export class IcsParseError extends Error {
  override name = "IcsParseError";
}

function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

type Property = { name: string; params: Record<string, string>; value: string };

function parseLine(line: string): Property {
  // The value starts after the first colon that is not inside a quoted
  // parameter value.
  let inQuotes = false;
  let split = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      split = i;
      break;
    }
  }
  if (split === -1) throw new IcsParseError(`Line has no value: ${line.slice(0, 60)}`);
  const head = line.slice(0, split);
  const value = line.slice(split + 1);
  const [name, ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value };
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseTime(prop: Property): IcsTime {
  const v = prop.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, time: null, tzid: null, utc: false };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) throw new IcsParseError(`Unsupported ${prop.name} value: ${v.slice(0, 40)}`);
  return {
    date: `${dt[1]}-${dt[2]}-${dt[3]}`,
    time: `${dt[4]}:${dt[5]}`,
    tzid: prop.params.TZID ?? null,
    utc: dt[7] === "Z",
  };
}

export function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(text);
  if (lines[0]?.toUpperCase() !== "BEGIN:VCALENDAR") throw new IcsParseError("Not an iCalendar file.");
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;
  let depth = 0; // nesting inside the current VEVENT, for VALARM blocks

  for (const line of lines) {
    const prop = parseLine(line);
    if (prop.name === "BEGIN") {
      if (prop.value.toUpperCase() === "VEVENT" && current === null) {
        current = { uid: null, summary: "", end: null, recurring: false };
        depth = 0;
      } else if (current !== null) {
        depth++;
      }
      continue;
    }
    if (prop.name === "END") {
      if (current !== null && depth > 0) {
        depth--;
      } else if (current !== null && prop.value.toUpperCase() === "VEVENT") {
        if (!current.start) throw new IcsParseError("VEVENT has no DTSTART.");
        events.push(current as IcsEvent);
        current = null;
      }
      continue;
    }
    if (current === null || depth > 0) continue;
    switch (prop.name) {
      case "UID":
        current.uid = prop.value;
        break;
      case "SUMMARY":
        current.summary = unescapeText(prop.value);
        break;
      case "DTSTART":
        current.start = parseTime(prop);
        break;
      case "DTEND":
        current.end = parseTime(prop);
        break;
      case "RRULE":
        current.recurring = true;
        break;
    }
  }
  if (current !== null) throw new IcsParseError("VEVENT is not closed.");
  return events.sort((a, b) => `${a.start.date}T${a.start.time ?? ""}`.localeCompare(`${b.start.date}T${b.start.time ?? ""}`));
}
