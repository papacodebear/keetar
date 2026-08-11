# Built-in icon set

Drop KeePass's 69 built-in entry icons here, named by index to match
`Consts.Icons` in `packages/core/src/defs/consts.ts`:

```
0.png    1.png    2.png    ...    68.png
```

PNG, square, any resolution (the UI renders them at a small fixed size).
The set doesn't need to be complete — `EntryIcon.tsx` falls back to a
generic icon for any index whose file is missing, and the webpack build
copies whatever's present here into the extension bundle without failing
if some (or all) files are absent.

Index → name (from `Consts.Icons`):

| # | Name | | # | Name | | # | Name |
|---|------|---|---|------|---|---|------|
| 0 | Key | | 24 | EnergyCareful | | 47 | Package |
| 1 | World | | 25 | EMailBox | | 48 | Folder |
| 2 | Warning | | 26 | Disk | | 49 | FolderOpen |
| 3 | NetworkServer | | 27 | Drive | | 50 | FolderPackage |
| 4 | MarkedDirectory | | 28 | PaperQ | | 51 | LockOpen |
| 5 | UserCommunication | | 29 | TerminalEncrypted | | 52 | PaperLocked |
| 6 | Parts | | 30 | Console | | 53 | Checked |
| 7 | Notepad | | 31 | Printer | | 54 | Pen |
| 8 | WorldSocket | | 32 | ProgramIcons | | 55 | Thumbnail |
| 9 | Identity | | 33 | Run | | 56 | Book |
| 10 | PaperReady | | 34 | Settings | | 57 | List |
| 11 | Digicam | | 35 | WorldComputer | | 58 | UserKey |
| 12 | IRCommunication | | 36 | Archive | | 59 | Tool |
| 13 | MultiKeys | | 37 | Homebanking | | 60 | Home |
| 14 | Energy | | 38 | DriveWindows | | 61 | Star |
| 15 | Scanner | | 39 | Clock | | 62 | Tux |
| 16 | WorldStar | | 40 | EMailSearch | | 63 | Feather |
| 17 | CDRom | | 41 | PaperFlag | | 64 | Apple |
| 18 | Monitor | | 42 | Memory | | 65 | Wiki |
| 19 | EMail | | 43 | TrashBin | | 66 | Money |
| 20 | Configuration | | 44 | Note | | 67 | Certificate |
| 21 | ClipboardReady | | 45 | Expired | | 68 | BlackBerry |
| 22 | PaperNew | | 46 | Info | | | |
| 23 | Screen | | | | | | |

This is the same fixed icon bank every KeePass-compatible client (KeePass,
KeePassXC, KeePassDX, Strongbox, ...) ships locally — nothing about the
icon travels inside a `.kdbx` file itself, just the index number.
