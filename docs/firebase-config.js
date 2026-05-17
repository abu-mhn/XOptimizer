// =============================================================================
// Firebase config for Swiss live sync.
//
// SETUP (one-time, ~5 minutes):
// 1. Go to https://console.firebase.google.com and create a new project
//    (Google Analytics not needed — skip it).
// 2. In the project dashboard, click the web icon (</>) to add a Web app.
//    Give it a nickname (e.g. "X Optimizer"), skip Firebase Hosting, Register.
//    You'll land on a screen showing `firebaseConfig`. Copy those values into
//    the FIREBASE_CONFIG object below, overwriting the blanks.
// 3. In the left nav, go to Build -> Realtime Database.
//    Click "Create Database", pick a region, and start in TEST MODE for now.
// 4. Still in Realtime Database, open the Rules tab and replace the contents
//    with the FULL rules block at the bottom of this file (the one with
//    `swissRooms`, `swissViewCodes`, `openTournaments`, `ranking`, and
//    `revoxRanking`), then click Publish.
//
//    Path roles:
//    - swissRooms       — tournament state keyed by the co-host code.
//    - swissViewCodes   — lookup mapping participant codes -> co-host codes.
//    - openTournaments  — public lobby of rooms accepting self-registration.
//                         Listed by the Rooms tab; needs read on the parent
//                         so the lobby can enumerate children.
//    - userTournaments  — per-account index of rooms a user hosts, so "My
//                         Tournaments" works on any device they sign in on.
//                         Keyed by Firebase Auth uid; needs read on the $uid
//                         node so a device can enumerate that account's rooms.
//    - ranking          — global Beyblade-X tournament leaderboard.
//    - revoxRanking     — Revox club leaderboard.
//
//    The rest of the DB stays locked. UI enforces who can score based on
//    which code the joiner used.
//
// If this file is left blank, the Swiss tab still works locally — it just
// won't sync between devices.
// =============================================================================

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCUnT-LVAfL4bwbwpcya241yhma7CZ9P4A",
  authDomain: "xoptimizer-57f89.firebaseapp.com",
  databaseURL: "https://xoptimizer-57f89-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "xoptimizer-57f89",
  appId: "1:724993646395:web:9f31108cf0225bd169211e"
};

// Host password rotates daily and is derived in tournament.js.

// SHA-256 of the Revox-admin password. Unlocks add/edit/delete on the
// Revox member ranking tab. Default password is "revoxadmin".
//
// To change: in any browser console, run
//   crypto.subtle.digest("SHA-256", new TextEncoder().encode("YOUR_PASSWORD"))
//     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("")));
// then paste the resulting hex string below.
window.TOURNAMENT_REVOX_ADMIN_SHA256 =
  "e466afc350e05dc5a73887167512284874e477041b7c728aa586a0e012080339";

// Replace the rules in Firebase Console with this block:
//   {
//     "rules": {
//       "swissRooms":      { "$code": { ".read": true, ".write": true } },
//       "swissViewCodes":  { "$code": { ".read": true, ".write": true } },
//       "openTournaments": { ".read": true, "$code": { ".write": true } },
//       "userTournaments": { "$uid": { ".read": "auth != null && auth.uid === $uid", ".write": "auth != null && auth.uid === $uid" } },
//       "ranking":         { ".read": true, "$name": { ".write": true } },
//       "revoxRanking":    { ".read": true, "$name": { ".write": true } }
//     }
//   }
//
// Notes on `openTournaments`:
// - `.read: true` is on the parent (not per-child) so the Rooms tab can
//   list every room in one shot. Per-child read wouldn't allow that — RTDB
//   rules cascade down, not up.
// - `$code/.write: true` lets any client publish a lobby entry under their
//   room's code; the host writes when opening registration and clears it
//   on Start / Reset. Same trust model as `swissRooms` — knowing the
//   editCode is the credential.


// // Import the functions you need from the SDKs you need
// import { initializeApp } from "firebase/app";
// import { getAnalytics } from "firebase/analytics";
// // TODO: Add SDKs for Firebase products that you want to use
// // https://firebase.google.com/docs/web/setup#available-libraries

// // Your web app's Firebase configuration
// // For Firebase JS SDK v7.20.0 and later, measurementId is optional
// const firebaseConfig = {
//   apiKey: "AIzaSyCUnT-LVAfL4bwbwpcya241yhma7CZ9P4A",
//   authDomain: "xoptimizer-57f89.firebaseapp.com",
//   projectId: "xoptimizer-57f89",
//   storageBucket: "xoptimizer-57f89.firebasestorage.app",
//   messagingSenderId: "724993646395",
//   appId: "1:724993646395:web:9f31108cf0225bd169211e",
//   measurementId: "G-ERZ7PWHP8E"
// };

// // Initialize Firebase
// const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app);