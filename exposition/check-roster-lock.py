#!/usr/bin/env python3
"""Fail if the public conference roster changes without an intentional lock update."""

from __future__ import annotations

import hashlib
import json
import sys
from html.parser import HTMLParser
from pathlib import Path


EXPECTED_COUNT = 125
EXPECTED_SHA256 = "ef3c9d22a580aa6b60c4e84636fe901fb31a719b592a6cc8c09cb538e62042d5"


class RosterParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.div_classes: list[set[str]] = []
        self.groups: list[dict[str, object]] = []
        self.group: dict[str, object] | None = None
        self.label_parts: list[str] | None = None
        self.person: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if tag == "div":
            self.div_classes.append(classes)
            if "fblock" in classes:
                self.group = {"group": "", "people": []}
            if self.group is not None and "f-label" in classes:
                self.label_parts = []
        elif (
            tag == "span"
            and self.group is not None
            and self._inside("namecards")
            and "ncard" in classes
        ):
            self.person = {
                "name_parts": [],
                "status": "confirmed" if "confirmed" in classes else "invited",
            }

    def handle_data(self, data: str) -> None:
        if self.person is not None:
            self.person["name_parts"].append(data)  # type: ignore[union-attr]
        elif self.label_parts is not None:
            self.label_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "span" and self.person is not None:
            name = " ".join("".join(self.person["name_parts"]).split())  # type: ignore[arg-type]
            self.group["people"].append(  # type: ignore[index,union-attr]
                {"name": name, "status": self.person["status"]}
            )
            self.person = None
        elif tag == "div" and self.div_classes:
            classes = self.div_classes.pop()
            if (
                "f-label" in classes
                and self.group is not None
                and self.label_parts is not None
            ):
                self.group["group"] = " ".join("".join(self.label_parts).split())
                self.label_parts = None
            if "fblock" in classes and self.group is not None:
                if self.group["people"]:
                    self.groups.append(self.group)
                self.group = None

    def _inside(self, class_name: str) -> bool:
        return any(class_name in classes for classes in self.div_classes)


def main() -> int:
    source = Path(__file__).with_name("index.html").read_text(encoding="utf-8")
    parser = RosterParser()
    parser.feed(source)
    count = sum(len(group["people"]) for group in parser.groups)  # type: ignore[arg-type]
    canonical = json.dumps(parser.groups, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    if count != EXPECTED_COUNT or digest != EXPECTED_SHA256:
        print(
            f"Roster lock FAILED: count={count}, sha256={digest}; "
            f"expected count={EXPECTED_COUNT}, sha256={EXPECTED_SHA256}.",
            file=sys.stderr,
        )
        print(
            "Do not change the roster without Jonathan's explicit instruction in the current task.",
            file=sys.stderr,
        )
        return 1

    print(f"Roster lock OK: {count} names across {len(parser.groups)} groups.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
