# Story Clock

An in-story clock for SillyTavern's main chat. The clock does **not** follow your
computer's time — it follows the story.

## What it does

- **Random opening time.** When a chat begins (the first message on screen), the clock
  picks a random plausible time — weighted towards waking hours — and that becomes
  "now" for this chat. That moment is also Day 1 of the story.
- **Time drifts as you talk.** Every reply from `{{char}}` pushes story time forward by a
  random gap (3–18 minutes by default), with an occasional longer skip (45–150 minutes),
  so the conversation quietly moves through the day. Your own messages don't move the
  clock; they're just stamped with the current time.
- **Stable history.** Each message remembers the story time it happened at, stored in its
  own `extra` data. Swiping, editing or deleting messages rewinds the clock correctly, and
  re-renders never shuffle the times around.
- **Per chat.** State lives in the chat's own metadata, so every chat and every branch
  keeps its own timeline.
- **`{{char}}` knows the time.** The current story time is injected as a short system line
  at the bottom of the prompt, so replies can match the light, the weather and what people
  would plausibly be doing at that hour.

## UI

A clock bar sits above the chat input:

- Time-of-day icon, the time itself, and a period label
  (รุ่งสาง / ตอนเช้า / เที่ยงวัน / ตอนบ่าย / ตอนเย็น / ตอนค่ำ / ดึกแล้ว / กลางดึก)
- Date and story-day counter, e.g. `ศุกร์ 18 ก.ย. • วันที่ 2 ของเรื่อง`
- The bar tints itself by time of day, from pale morning blues to near-black at 3am
- Buttons: `+1 ชม.`, `เช้าวันถัดไป`, and a pencil that opens an inline editor
  (set an exact time, skip N days, or re-roll the clock)
- An optional small story-time stamp under every message

## Settings

Found in the Extensions panel:

| Setting | Meaning |
| --- | --- |
| เปิดใช้งาน | Master on/off |
| แสดงแถบนาฬิกาด้านบน | Show or hide the clock bar |
| แสดงเวลาใต้ข้อความ | Show or hide per-message stamps |
| ส่งเวลาเข้าพรอมต์ให้บอทรู้ | Inject the time into the prompt |
| เวลาที่เดินต่อหนึ่งตา | Minute range added per reply |
| โอกาสข้ามเวลานาน ๆ | Chance of a long time skip, in percent |

## Install

Copy the folder into:

```
SillyTavern/public/scripts/extensions/third-party/story-clock/
```

so that `manifest.json`, `index.js` and `style.css` sit directly inside it, then reload
SillyTavern.

Alternatively, install from a Git URL through SillyTavern's **Extensions → Install
extension** dialog.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest read by SillyTavern |
| `index.js` | Clock state, prompt injection, UI and settings |
| `style.css` | Clock bar, time-of-day tints, message stamps |

## Notes

- Story time is stored as a timestamp in `message.extra.storyClock` and in the chat
  metadata key `storyClock`. Removing the extension leaves that data harmlessly in place.
- The extension only reads and writes its own keys; it doesn't modify message text.
