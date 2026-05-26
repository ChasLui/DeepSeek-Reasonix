# E1 Report: mouse-mode write-sequence audit

Status: PASS for the startup/cleanup sequence on current HEAD.

## Evidence command

```sh
rm -f /tmp/mm-startup.log
script -q /tmp/mm-startup.log npm run dev -- chat --no-session --no-dashboard --new --no-config
# press Esc in the session picker to exit
xxd -g 1 /tmp/mm-startup.log | rg '1b 5b 3f|1b 5b 32|1b 5b 33|1b 5b 48'
perl -0777 -ne 'while(/\e\[\?([0-9;]+)([hl])/g){ print "?${1}${2}\n" } while(/\e\[([0-9;]*)([A-Za-z])/g){ print "CSI ${1}${2}\n" }' /tmp/mm-startup.log
```

## Raw sequence summary

```text
?1000h
?1006h
?2026h
?25l
?2026l
?1006l
?1000l
?2026h
?2026l
?25h
?25h
?25h
CSI 2J
CSI 3J
CSI H
```

Important byte offsets:

```text
00000060: ... 1b 5b 3f 31 30 30 30 68 1b 5b 3f 31 30 30 36 68 ...
00000830: ... 1b 5b 3f 31 30 30 36 6c 1b 5b 3f 31 30 30 30 6c ...
```

## Source comparison

`src/cli/ui/mouse-mode.ts`:

```text
8: const ENABLE = "\u001b[?1000h\u001b[?1006h";
9: const DISABLE = "\u001b[?1006l\u001b[?1000l";
```

`tests/mouse-mode.test.ts` asserts the same pair:

```text
31: expect(writes.join("")).toBe("\u001b[?1000h\u001b[?1006h");
44: expect(writes.join("")).toBe("\u001b[?1006l\u001b[?1000l");
```

## Findings

- Only `1000` and `1006` are enabled by `mouse-mode.ts`.
- No `1002`, `1003`, or `1004` enable sequence appeared in this startup capture.
- The `2026` synchronized-output and cursor visibility sequences are unrelated to mouse tracking.
- E1 supports the v2 correction: DISABLE is symmetric for the modes this file opens.

## Caveat

This only captures one startup path: `chat` -> session picker -> Esc exit. It does not prove every possible runtime path, but it directly exercises the current TUI startup path that enables mouse mode.

