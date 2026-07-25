# Avalon Public Calendar

Status: transitional integration

This route renders two deliberately separate kinds of calendar data:

- Named public events explicitly posted to the Avalon Institute Partiful profile.
- Anonymous intervals when Avalon House is unavailable.

The page must never receive a private event title, description, attendee, location,
calendar id, source id, or calendar subscription URL.

## Feed contract

`index.html` reads:

```text
https://house.51.81.186.112.sslip.io/api/public/calendar
```

The response shape is:

```json
{
  "timezone": "America/Los_Angeles",
  "asOf": "2026-07-24T17:30:00-07:00",
  "window": {"start": "...", "end": "..."},
  "sources": {
    "partiful": {"status": "ok"},
    "availability": {"status": "ok"}
  },
  "events": [
    {
      "id": "PartifulEventId",
      "title": "Public event title",
      "start": "2026-07-25T02:00:00Z",
      "end": null,
      "timezone": "America/Los_Angeles",
      "url": "https://partiful.com/e/PartifulEventId"
    }
  ],
  "busy": [
    {
      "kind": "unavailable",
      "start": "2026-07-26T01:00:00Z",
      "end": "2026-07-26T05:00:00Z",
      "allDay": false
    }
  ]
}
```

The browser validates and whitelists these fields again. It calls only the cached
Avalon endpoint, so a traffic spike does not fan out to Partiful. If that endpoint is
down, the page links visitors to the Avalon Partiful profile and does not invent
availability.

## Disclosure rules

Partiful does not provide a documented organizer API or an `isPublic` field in this
response. Avalon therefore treats profile membership as one disclosure gate: only
events intended for the public website may be posted to the Avalon Partiful profile.
The adapter also fails closed on every non-null `discoverableAudience` value so an
event restricted to, for example, mutuals of the hosts is not published.

The Partiful personal calendar subscription must not be used here. It is a secret
feed that mixes hosted, attending, maybe, waitlist, and invited events.

The public-profile callable is undocumented and currently returns at most 50 rows.
Treat the adapter as monitored, transitional infrastructure; request an official
organizer feed or written permission from Partiful before depending on it as a
permanent source.

Busy intervals come from the private `Avalon House Blocks` projection. The public
endpoint reads only rows carrying the block reconciler's exact private marker and
serializes only their start and end. Do not expose the Google calendar id or its ICS
URL.

`Avalon House Shared` is not yet a complete record of all institute events. Until a
single source of truth is live, every house booking must also be entered there or it
will not appear as unavailable. Avalon Passport should replace the transitional
Partiful adapter when its public event index is deployed.

## Local check

Serve the website root and use the local-only fixture:

```text
http://localhost:8000/calendar/?feed=sample&month=2026-07
```

The `feed=sample` override is accepted only on `localhost` and `127.0.0.1`.
