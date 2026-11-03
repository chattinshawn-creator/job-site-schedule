# Job Site Schedule

Shared construction calendar for the project coordinator, site lead and subs. Anyone with the link can view; editing requires the team passcode, entered once per device.

- `index.html` is the page.
- `firebase-config.js` holds the Firebase project settings.
- `firestore.rules` are the database security rules. Paste them into Firebase > Firestore Database > Rules whenever they change.

## Changing the team passcode

1. Firebase console > Firestore Database > Data > `config` > `passcode`.
2. Edit the `code` field and save.
3. Devices already unlocked stay unlocked. To lock everyone out, delete the documents in the `editors` collection; each person then unlocks again with the new passcode.
