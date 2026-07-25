(() => {
  "use strict";

  const configElement = document.getElementById("calendar-config");
  const config = JSON.parse(configElement.textContent);
  const timezone = config.timezone || "America/Los_Angeles";
  const params = new URLSearchParams(window.location.search);
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const feedUrl = isLocal && params.get("feed") === "sample"
    ? "feed.sample.json"
    : config.feedUrl;

  const monthTitle = document.getElementById("calendar-title");
  const monthGrid = document.getElementById("month-grid");
  const agenda = document.getElementById("agenda");
  const calendarFrame = document.getElementById("calendar-frame");
  const emptyState = document.getElementById("empty-state");
  const emptyMessage = document.getElementById("empty-message");
  const feedStatus = document.getElementById("feed-status");
  const eventSchema = document.getElementById("event-schema");
  const previousMonthButton = document.getElementById("previous-month");
  const nextMonthButton = document.getElementById("next-month");
  const todayButton = document.getElementById("today");

  const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const monthFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });

  const longDateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });

  const updateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const coverageFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  });

  const state = {
    events: [],
    busy: [],
    sources: {},
    asOf: null,
    windowStart: null,
    windowEnd: null,
    loaded: false,
    month: initialMonth(params.get("month")),
  };

  function partsFor(value) {
    return Object.fromEntries(
      dateKeyFormatter
        .formatToParts(value)
        .filter(part => part.type !== "literal")
        .map(part => [part.type, part.value])
    );
  }

  function dateKey(value) {
    const parts = partsFor(value);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function initialMonth(value) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value || "")) {
      const [year, month] = value.split("-").map(Number);
      return { year, month: month - 1 };
    }
    const [year, month] = dateKey(new Date()).split("-").map(Number);
    return { year, month: month - 1 };
  }

  function monthKey(month) {
    return `${month.year}-${String(month.month + 1).padStart(2, "0")}`;
  }

  function monthIndex(month) {
    return month.year * 12 + month.month;
  }

  function feedMonthBounds() {
    if (!state.windowStart || !state.windowEnd || state.windowEnd <= state.windowStart) {
      return null;
    }
    const start = partsFor(state.windowStart);
    const finalMoment = new Date(state.windowEnd.getTime() - 1);
    const end = partsFor(finalMoment);
    return {
      first: { year: Number(start.year), month: Number(start.month) - 1 },
      last: { year: Number(end.year), month: Number(end.month) - 1 },
    };
  }

  function feedDateBounds() {
    if (!state.windowStart || !state.windowEnd || state.windowEnd <= state.windowStart) {
      return null;
    }
    return {
      firstKey: dateKey(state.windowStart),
      lastKey: dateKey(new Date(state.windowEnd.getTime() - 1)),
    };
  }

  function coverageNote() {
    if (!state.windowEnd) return "";
    return ` · Listed through ${coverageFormatter.format(new Date(state.windowEnd.getTime() - 1))}`;
  }

  function clampMonthToFeed() {
    const bounds = feedMonthBounds();
    if (!bounds) return false;
    const current = monthIndex(state.month);
    if (current < monthIndex(bounds.first)) {
      state.month = { ...bounds.first };
      return true;
    }
    if (current > monthIndex(bounds.last)) {
      state.month = { ...bounds.last };
      return true;
    }
    return false;
  }

  function dayKey(year, month, day) {
    return [
      String(year).padStart(4, "0"),
      String(month + 1).padStart(2, "0"),
      String(day).padStart(2, "0"),
    ].join("-");
  }

  function addDaysToKey(key, amount) {
    const [year, month, day] = key.split("-").map(Number);
    const value = new Date(Date.UTC(year, month - 1, day + amount, 12));
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, "0"),
      String(value.getUTCDate()).padStart(2, "0"),
    ].join("-");
  }

  function validDate(value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function sanitizeEvent(row) {
    if (!row || typeof row !== "object") return null;
    const id = String(row.id || "");
    const title = String(row.title || "").trim();
    const start = validDate(row.start);
    const end = row.end ? validDate(row.end) : null;
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(id) || !title || title.length > 300 || !start) {
      return null;
    }
    return {
      id,
      title,
      start,
      end: end && end > start ? end : null,
      timezone,
      url: `https://partiful.com/e/${id}`,
      kind: "event",
    };
  }

  function sanitizeBusy(row) {
    if (!row || typeof row !== "object") return null;
    const start = validDate(row.start);
    const end = validDate(row.end);
    if (!start || !end || end <= start) return null;
    return {
      start,
      end,
      allDay: row.allDay === true || row.all_day === true,
      kind: "unavailable",
    };
  }

  function sourceIsCurrent(source) {
    const status = String(source?.status || "").toLowerCase();
    return ["ok", "current", "ready", "sample"].includes(status);
  }

  async function fetchJson(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function loadCalendar() {
    let feed = null;
    let feedError = false;

    try {
      feed = await fetchJson(feedUrl);
    } catch (error) {
      feedError = true;
      console.warn("Public calendar feed is unavailable", error);
    }

    const rawEvents = Array.isArray(feed?.events) ? feed.events : [];
    const rawBusy = Array.isArray(feed?.busy) ? feed.busy : [];
    const events = rawEvents.map(sanitizeEvent).filter(Boolean);
    const busy = rawBusy.map(sanitizeBusy).filter(Boolean);
    const partifulCurrent = sourceIsCurrent(feed?.sources?.partiful);

    state.events = uniqueEvents(events);
    state.busy = busy;
    state.sources = {
      partiful: {
        status: partifulCurrent ? "ok" : "unavailable",
      },
      availability: {
        status: sourceIsCurrent(feed?.sources?.availability) ? "ok" : "unavailable",
      },
    };
    state.asOf = validDate(feed?.asOf || feed?.as_of);
    state.windowStart = validDate(feed?.window?.start);
    state.windowEnd = validDate(feed?.window?.end);
    state.loaded = true;
    if (clampMonthToFeed()) replaceMonthQuery();

    calendarFrame.setAttribute("aria-busy", "false");
    render();
    renderSchema();
    renderStatus(feedError);
  }

  function uniqueEvents(events) {
    const seen = new Set();
    return events
      .filter(event => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      })
      .sort((left, right) => left.start - right.start);
  }

  function eventMap() {
    const map = new Map();
    state.events.forEach(event => {
      const key = dateKey(event.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    });
    return map;
  }

  function publicSubtractedSegments(block) {
    let segments = [{ start: block.start, end: block.end }];
    state.events
      .filter(event => event.end && event.start < block.end && event.end > block.start)
      .sort((left, right) => left.start - right.start)
      .forEach(event => {
        segments = segments.flatMap(segment => {
          if (event.end <= segment.start || event.start >= segment.end) {
            return [segment];
          }
          const remainder = [];
          if (event.start > segment.start) {
            remainder.push({
              start: segment.start,
              end: new Date(Math.min(event.start.getTime(), segment.end.getTime())),
            });
          }
          if (event.end < segment.end) {
            remainder.push({
              start: new Date(Math.max(event.end.getTime(), segment.start.getTime())),
              end: segment.end,
            });
          }
          return remainder;
        });
      });
    return segments.map(segment => ({
      ...block,
      ...segment,
      allDay: block.allDay
        && segment.start.getTime() === block.start.getTime()
        && segment.end.getTime() === block.end.getTime(),
    }));
  }

  function busyMap() {
    const map = new Map();
    state.busy.forEach(block => {
      publicSubtractedSegments(block).forEach(segment => {
        const firstKey = dateKey(segment.start);
        const finalMoment = new Date(segment.end.getTime() - 1);
        const lastKey = dateKey(finalMoment);
        let key = firstKey;
        let guard = 0;

        while (key <= lastKey && guard < 370) {
          if (!map.has(key)) map.set(key, []);
          map.get(key).push({
            ...segment,
            dateKey: key,
            firstKey,
            lastKey,
          });
          key = addDaysToKey(key, 1);
          guard += 1;
        }
      });
    });
    return map;
  }

  function entriesForDay(key, eventsByDay, busyByDay) {
    const events = eventsByDay.get(key) || [];
    const unavailable = busyByDay.get(key) || [];
    return [...events, ...unavailable].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "event" ? -1 : 1;
      return left.start - right.start;
    });
  }

  function formatTime(value) {
    return timeFormatter.format(value).replace(/\s/g, " ");
  }

  function formatEventTime(event) {
    if (!event.end) return formatTime(event.start);
    return `${formatTime(event.start)}–${formatTime(event.end)}`;
  }

  function formatBusyTime(block) {
    if (block.allDay) return "All day";
    if (block.firstKey === block.lastKey) {
      return `${formatTime(block.start)}–${formatTime(block.end)}`;
    }
    if (block.dateKey === block.firstKey) return `${formatTime(block.start)} onward`;
    if (block.dateKey === block.lastKey) return `Until ${formatTime(block.end)}`;
    return "All day";
  }

  function entryElement(entry, key) {
    const isEvent = entry.kind === "event";
    const element = document.createElement(isEvent ? "a" : "div");
    element.className = `calendar-entry ${isEvent ? "event" : "unavailable"}`;

    const time = document.createElement("span");
    time.className = "entry-time";
    time.textContent = isEvent ? formatEventTime(entry) : formatBusyTime(entry);

    const title = document.createElement("span");
    title.className = "entry-title";
    title.textContent = isEvent ? entry.title : "Unavailable";

    element.append(time, title);

    if (isEvent) {
      element.href = entry.url;
      element.target = "_blank";
      element.rel = "noopener";
      element.setAttribute(
        "aria-label",
        `${entry.title}, ${longDateFormatter.format(entry.start)}, ${formatEventTime(entry)}. Opens in Partiful.`
      );
    } else {
      element.setAttribute(
        "aria-label",
        `${longDateFromKey(key)}, ${formatBusyTime(entry)}: unavailable`
      );
    }
    return element;
  }

  function longDateFromKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return longDateFormatter.format(new Date(Date.UTC(year, month - 1, day, 12)));
  }

  function render() {
    const eventsByDay = eventMap();
    const busyByDay = busyMap();
    const dateBounds = feedDateBounds();
    const monthDate = new Date(Date.UTC(state.month.year, state.month.month, 1, 12));
    monthTitle.textContent = monthFormatter.format(monthDate);
    monthGrid.textContent = "";
    agenda.textContent = "";

    const firstWeekday = monthDate.getUTCDay();
    const daysThisMonth = new Date(
      Date.UTC(state.month.year, state.month.month + 1, 0, 12)
    ).getUTCDate();
    const gridDays = firstWeekday + daysThisMonth > 35 ? 42 : 35;
    const firstGridDate = new Date(
      Date.UTC(state.month.year, state.month.month, 1 - firstWeekday, 12)
    );
    let monthHasEntries = false;

    for (let index = 0; index < gridDays; index += 1) {
      const date = new Date(firstGridDate);
      date.setUTCDate(firstGridDate.getUTCDate() + index);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth();
      const day = date.getUTCDate();
      const key = dayKey(year, month, day);
      const inMonth = month === state.month.month && year === state.month.year;
      const inFeed = !dateBounds
        || (key >= dateBounds.firstKey && key <= dateBounds.lastKey);
      const entries = inMonth ? entriesForDay(key, eventsByDay, busyByDay) : [];

      if (entries.length) monthHasEntries = true;

      const cell = document.createElement("div");
      cell.className = [
        "day",
        inMonth ? "" : "outside",
        inFeed ? "" : "outside-feed",
        key === todayKey() ? "today" : "",
      ].filter(Boolean).join(" ");
      cell.setAttribute("role", "listitem");

      const number = document.createElement("span");
      number.className = "day-number";
      number.textContent = String(day);
      number.setAttribute("aria-hidden", "true");

      const accessibleDate = document.createElement("span");
      accessibleDate.className = "visually-hidden";
      accessibleDate.textContent = `${longDateFromKey(key)}.${inFeed ? "" : " Outside the published schedule."}`;
      cell.append(accessibleDate, number);

      if (entries.length) {
        const entryList = document.createElement("div");
        entryList.className = "day-entries";
        entries.slice(0, 3).forEach(entry => entryList.appendChild(entryElement(entry, key)));
        if (entries.length > 3) {
          const more = document.createElement("span");
          more.className = "more-count";
          more.textContent = `+${entries.length - 3} more`;
          entryList.appendChild(more);
        }
        cell.appendChild(entryList);
      }
      monthGrid.appendChild(cell);
    }

    renderAgenda(eventsByDay, busyByDay);
    const partifulCurrent = sourceIsCurrent(state.sources.partiful);
    const availabilityCurrent = sourceIsCurrent(state.sources.availability);
    const showEmpty = state.loaded
      && !monthHasEntries
      && (partifulCurrent || availabilityCurrent);
    if (partifulCurrent && availabilityCurrent) {
      emptyMessage.textContent = "No public events or unavailable dates are listed for this month.";
    } else if (partifulCurrent) {
      emptyMessage.textContent = "No public events are listed for this month.";
    } else {
      emptyMessage.textContent = "No unavailable dates are listed for this month.";
    }
    emptyState.hidden = !showEmpty;
    emptyState.style.display = showEmpty ? "flex" : "none";
    updateNavigationState();
  }

  function renderAgenda(eventsByDay, busyByDay) {
    const daysThisMonth = new Date(
      Date.UTC(state.month.year, state.month.month + 1, 0, 12)
    ).getUTCDate();

    for (let day = 1; day <= daysThisMonth; day += 1) {
      const key = dayKey(state.month.year, state.month.month, day);
      const entries = entriesForDay(key, eventsByDay, busyByDay);
      if (!entries.length) continue;

      const section = document.createElement("section");
      section.className = "agenda-day";

      const heading = document.createElement("h3");
      heading.className = "agenda-date";
      heading.textContent = longDateFromKey(key);

      const entryList = document.createElement("div");
      entryList.className = "agenda-entries";
      entries.forEach(entry => entryList.appendChild(entryElement(entry, key)));

      section.append(heading, entryList);
      agenda.appendChild(section);
    }
  }

  function renderSchema() {
    const graph = state.events
      .filter(event => event.start >= new Date())
      .slice(0, 50)
      .map(event => {
        const row = {
          "@type": "Event",
          name: event.title,
          startDate: event.start.toISOString(),
          eventStatus: "https://schema.org/EventScheduled",
          url: event.url,
          organizer: {
            "@type": "Organization",
            name: "The Avalon Institute",
            url: "https://avalon.institute/",
          },
        };
        if (event.end) row.endDate = event.end.toISOString();
        return row;
      });
    eventSchema.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": graph,
    });
  }

  function renderStatus(feedError) {
    const partifulCurrent = sourceIsCurrent(state.sources.partiful);
    const availabilityCurrent = sourceIsCurrent(state.sources.availability);
    feedStatus.classList.toggle("warning", !partifulCurrent || !availabilityCurrent);

    if (partifulCurrent && availabilityCurrent) {
      feedStatus.textContent = state.asOf
        ? `Updated ${updateFormatter.format(state.asOf)}${coverageNote()}`
        : `Public events and house availability are current${coverageNote()}.`;
      return;
    }
    if (partifulCurrent) {
      feedStatus.textContent = "Public events are current. House availability is temporarily unavailable.";
      return;
    }
    if (availabilityCurrent) {
      feedStatus.textContent = "House availability is current. Public event listings are temporarily unavailable.";
      return;
    }
    feedStatus.textContent = feedError
      ? "Current dates could not be loaded. View Avalon on Partiful for public events."
      : "Public events and house availability are temporarily unavailable.";
  }

  function updateNavigationState() {
    const bounds = feedMonthBounds();
    if (!bounds) {
      previousMonthButton.disabled = false;
      nextMonthButton.disabled = false;
      return;
    }
    const current = monthIndex(state.month);
    previousMonthButton.disabled = current <= monthIndex(bounds.first);
    nextMonthButton.disabled = current >= monthIndex(bounds.last);
  }

  function replaceMonthQuery() {
    const url = new URL(window.location.href);
    url.searchParams.set("month", monthKey(state.month));
    window.history.replaceState({}, "", url);
  }

  function shiftMonth(amount) {
    const date = new Date(Date.UTC(state.month.year, state.month.month + amount, 1, 12));
    state.month = { year: date.getUTCFullYear(), month: date.getUTCMonth() };
    clampMonthToFeed();
    replaceMonthQuery();
    render();
  }

  previousMonthButton.addEventListener("click", () => shiftMonth(-1));
  nextMonthButton.addEventListener("click", () => shiftMonth(1));
  todayButton.addEventListener("click", () => {
    state.month = initialMonth(null);
    clampMonthToFeed();
    const url = new URL(window.location.href);
    if (monthKey(state.month) === monthKey(initialMonth(null))) {
      url.searchParams.delete("month");
    } else {
      url.searchParams.set("month", monthKey(state.month));
    }
    window.history.replaceState({}, "", url);
    render();
  });

  render();
  loadCalendar();
})();
