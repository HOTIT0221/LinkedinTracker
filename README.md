# LinkedIn Tracker

A private Windows desktop app that keeps a log of your LinkedIn conversations: who you wrote to, what
you sent, what they replied, and who still owes you an answer.

- **Contacts** with photo, headline, country, profile link and notes, under one or more of your own
  LinkedIn accounts (switch with the account menu at the top, or `Ctrl+1…9`, `Ctrl+0` for all).
- **Messages** you sent and replies you received, with date and time, pasted or dropped **images**,
  and a **"seen"** marker for sent messages.
- **Filters and search:** awaiting reply, seen but no reply, replied, no messages; search names,
  profile links, countries and message text.

Until HOTIT Manager 3.8 this was the LinkedIn section of HOTIT Manager. It is a separate app now, with
its own data.

## Use it

- **Install:** run `dist\LinkedIn Tracker Setup 1.0.0.exe`, or
- **No install:** run `dist\LinkedInTracker-Portable-1.0.0.exe`.

`Ctrl+N` adds a contact, `Ctrl+F` searches, `Ctrl+Enter` adds the message, `Alt+1` / `Alt+2` switch
between "I sent" and "They replied", `Alt+↑` / `Alt+↓` move between conversations.

## Moving your messages from HOTIT Manager

On its first start, LinkedIn Tracker offers to import your LinkedIn contacts, messages, images and
accounts from HOTIT Manager on the same PC (also later: **File → Import from HOTIT Manager…**).

- It looks in HOTIT Manager's database and its backups
  (`%APPDATA%\IT Business Manager\backups`). HOTIT Manager 3.8 removed the LinkedIn data from its
  own database after keeping a copy as it was (`before-upgrade-from-v8-….db`); that copy is found
  automatically.
- If HOTIT Manager's database is encrypted, you are asked for its password once.
- HOTIT Manager's files are only read, never changed. Importing twice adds nothing twice.
- A HOTIT Manager database or backup kept somewhere else can be chosen with **File → Import backup…**.

## Your data

Everything lives in one SQLite database, by default `%APPDATA%\LinkedIn Tracker\tracker.db`.
Every change is written immediately. The database is not encrypted.

- **File → Export backup…** saves a copy of the database (`.db`). **Import backup…** restores or
  merges such a copy (or a HOTIT Manager database / backup).
- **Settings → Change location…** moves the database, e.g. into a OneDrive/Dropbox folder.
- Automatic backups in `%APPDATA%\LinkedIn Tracker\backups`: daily (last 30) and monthly (kept
  forever), plus a copy before each database upgrade or import.
- Deleted contacts and messages are kept hidden for 30 days (with Undo) before being purged.

## Develop

```
npm install
npm start        # run the app
npm run dist     # build installer + portable exe into dist/
```

If you run these from a VS Code terminal and Electron starts as plain Node, clear `ELECTRON_RUN_AS_NODE` first.

`cryptfile.js` is HOTIT Manager's file encryption, used here only to read an encrypted HOTIT Manager
database when importing from it.
