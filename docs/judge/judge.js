// docs/judge/judge.js — the Judge tab.
//
// THE LADDER: Guest Judge < Judge < Head Judge. Each rung replaces the one
// below it rather than stacking on it, so a promoted Guest Judge drops that
// tag rather than wearing both, and a Head Judge needs no separate Judge tag
// to do a Judge's job.
//
// Three sub-tabs:
//
//   Exam      a TIMED sitting on the official Beyblade X tournament
//             regulations. Its result files an APPLICATION, not a tag.
//   Ranking   judges ordered by how many events they have run, counting both
//             hosting and co-hosting.
//   Approvals a Head Judge signs applications off. Hidden from everyone else.
//
// HOW SOMEONE BECOMES A JUDGE
//
//   1. They sit the exam against a clock. Three outcomes:
//        * every answer right, in time   -> applies for "Judge"
//        * all answered in time, not all right -> applies for "Guest Judge"
//        * the clock beat them           -> nothing is filed; sit it again
//      Their device writes judgeApplications/{uid} with the score, the role
//      earned, and status "pending".
//
//      A perfect score is the bar for Judge because a judge's calls are not
//      partially right in a tournament. Guest Judge is the consolation and a
//      real role: it carries co-hosting but not the right to create a
//      tournament, so someone who knows most of the rules can still be useful
//      beside someone who knows all of them.
//   2. A Head Judge (or a Developer, who counts as one) approves it on the
//      Approvals tab. That write sets status to "approved" and, in the same
//      breath, the two PUBLIC markers: profiles/{key}/tags/<role> for the badge
//      everyone sees, and judges/{key} so the Battle Royale picker and the
//      sub-host typeahead find them straight away (both roles feed that index).
//   3. The applicant's own device claims users/{uid}/tags/<role>, which is what
//      isJudge() / isGuestJudge() actually read. The database rules allow that claim only when
//      the application says approved, so step 2 has to have happened. It lands
//      the next time they open this tab, which is why the Exam tab checks for
//      an approved-but-unclaimed application every time it renders.
//
// Step 3 is the applicant's own write because users/{uid} is writable only by
// that account and by Developers — a Head Judge cannot reach into it. Hence
// the split: the public markers appear the moment it is approved, and the
// private tag catches up on their next visit.
//
// The exam is a competence gate and the approval is the real one. A determined
// person could file an application with a perfect score from a console, and
// the clock is client-side so it can be lied to as well; what they cannot do
// is approve it. The timer is there to stop someone reading the answers off
// another tab, not to stop someone editing their own JavaScript.
(function () {
  "use strict";

  // The clock turns red for the last quarter of the sitting. Kept as a
  // fraction rather than a flat minute: a minute was a sensible warning on a

  const JUDGE_TAG = "Judge";
  const GUEST_TAG = "Guest Judge";
  const HEAD_TAG = "Head Judge";
  // Lowest first. Earning a rung drops everything below it, so nobody wears
  // two badges for the same thing — in the account's own tags and in the
  // public profile both.
  const ROLE_LADDER = [GUEST_TAG, JUDGE_TAG, HEAD_TAG];
  function rolesBelow(tag) {
    const i = ROLE_LADDER.indexOf(tag);
    return i > 0 ? ROLE_LADDER.slice(0, i) : [];
  }
  // Every tag that keeps a name in the public `judges` index — the list the
  // sub-host typeahead and the Battle Royale picker read. Mirrors
  // PUBLIC_TAG_INDEXES in auth.js; both must name the same set or a rejection
  // here will evict someone another tag still entitles to be there.
  const INDEXED_TAGS = ["Judge", "Head Judge", "Guest Judge", "Keeper"];

  // Straight from the official regulations (12th Edition and the 2026
  // updates). `a` is the index of the correct option.
  // The rules questions. Both exams draw on these; the Head Judge paper adds
  // the manual ones below.
  const RULES_QUESTIONS = [
    {
      q: "How many points does a Survivor Finish score?",
      o: ["1 point", "2 points", "3 points", "No points"],
      a: 0,
      why: "A Survivor Finish is 1 point — your Beyblade is still spinning after your opponent's has stopped.",
    },
    {
      q: "Your opponent's Beyblade is knocked out of the main play area into the side pocket. What is that worth?",
      o: ["1 point", "2 points", "3 points", "4 points"],
      a: 1,
      why: "A Knockout Finish is 2 points.",
    },
    {
      q: "How many points is a Burst Finish?",
      o: ["1 point", "2 points", "3 points", "It ends the match"],
      a: 1,
      why: "A Burst Finish is 2 points — the same as a Knockout.",
    },
    {
      q: "A Beyblade is sent into the central Xtreme pocket by an Xtreme Dash. What is that worth?",
      o: ["1 point", "2 points", "3 points", "5 points"],
      a: 2,
      why: "An Xtreme Finish is 3 points, the highest single finish.",
    },
    {
      q: "How many points wins a standard match?",
      o: ["3 points", "4 points", "5 points", "7 points"],
      a: 1,
      why: "First to 4 points takes the match. Specific tournament final stages are played to 7.",
    },
    {
      q: "Both Beyblades stop at the same moment. What do you call?",
      o: [
        "A point to each blader",
        "A point to the blader who launched second",
        "No points — replay the battle",
        "The battle is void and the match restarts from 0",
      ],
      a: 2,
      why: "A Draw scores nothing for either side and the battle is replayed. The match score is untouched.",
    },
    {
      q: "In the 3-on-3 format, what must be true of the three combos in a deck?",
      o: [
        "They must share a Blade but differ in Ratchet and Bit",
        "No part may be repeated across the three combos",
        "Only the Bit must differ between combos",
        "Any parts may repeat as long as the combos differ",
      ],
      a: 1,
      why: "No Blade, Ratchet or Bit may be duplicated anywhere across the three combos.",
    },
    {
      q: "Which of these is LEGAL in official play?",
      o: [
        "A 3D-printed Bit",
        "A part from the older Beyblade Burst series",
        "An official Beyblade X part released after July 2023",
        "A Ratchet swapped out of a different Blade's assembly",
      ],
      a: 2,
      why: "Only official Beyblade X parts, released July 2023 onward, are legal.",
    },
    {
      q: "A blader turns up with a modified Bit, filed down to change its shape. What do you do?",
      o: [
        "Allow it if both bladers agree",
        "Allow it in group stages only",
        "Refuse it — modified parts are illegal",
        "Allow it but award the opponent a point",
      ],
      a: 2,
      why: "Modified parts are strictly illegal, with no agreement between bladers that can permit them.",
    },
    {
      q: "Which specific part is universally banned in competitive play?",
      o: ["Metal Needle", "Rubber Accel", "High Taper", "Metal Ball"],
      a: 0,
      why: "The Metal Needle bit is banned outright.",
    },
  ];

  // Questions from the Manual — running a tournament, not scoring a battle.
  // A Head Judge approves other judges and directs matches, so knowing the
  // rules is the floor, not the bar.
  const MANUAL_QUESTIONS = [
    {
      q: "Which tag is required to create a tournament?",
      o: ["Guest Judge", "Judge", "Keeper", "Any signed-in account"],
      a: 1,
      why: "Judge \u2014 and a Head Judge counts as one. A Guest Judge can be invited to co-host but cannot create.",
    },
    {
      q: "When are a tournament's date, time and stadium asked for?",
      o: [
        "Every time you tap Share",
        "Once, when the tournament is created",
        "Only after the tournament finishes",
        "They are never asked \u2014 you type them into the share message",
      ],
      a: 1,
      why: "Once at creation, so Share just shares. The Details button reopens them later.",
    },
    {
      q: "A co-host's phone dies mid-tournament. Who can still score their match?",
      o: [
        "Nobody \u2014 the match is stuck",
        "The host, and any other co-host",
        "Only the player who was assigned it",
        "Only a Head Judge",
      ],
      a: 1,
      why: "Scoring is open to the host and every co-host. Being put on a match directs who should run it; it never leaves a match unreachable.",
    },
    {
      q: "A player registered weeks ago and has built a new deck since. What happens?",
      o: [
        "Their registered deck updates automatically",
        "They are stuck with the old deck",
        "They can change it themselves, and the judge is told",
        "Only the host can change it, in secret",
      ],
      a: 2,
      why: "They change it from Your Matches, and host and co-hosts get a toast naming them \u2014 check it at Bey Check.",
    },
    {
      q: "What does Bey Check pre-fill each player's deck from?",
      o: [
        "Nothing \u2014 the judge types it in",
        "What they registered",
        "The last tournament they played",
        "Their highest-rated deck",
      ],
      a: 1,
      why: "From the registration, with any banned part flagged. The judge can change it there if the player has switched.",
    },
    {
      q: "A finished tournament is still sitting in the lobby. What happens if nobody closes it?",
      o: [
        "It stays there forever",
        "It closes automatically at midnight, Malaysia time",
        "It is deleted along with its results",
        "It reopens for registration",
      ],
      a: 1,
      why: "Closed automatically overnight. The results were archived when the final standings appeared, so nothing is lost.",
    },
    {
      q: "When are a tournament's results saved to Past Tournaments?",
      o: [
        "When the host taps Leave",
        "The moment the final standings appear",
        "At midnight",
        "Only if the host taps Share first",
      ],
      a: 1,
      why: "Before anybody touches a button. That is why the exit button turns into Leave rather than Reset.",
    },
    {
      q: "A player closed their tab mid-tournament. How do they get back to their matches?",
      o: [
        "They cannot \u2014 registration has closed",
        "The host must re-add them by hand",
        "They open the tournament again and rejoin",
        "They must register a second time",
      ],
      a: 2,
      why: "Registration closing shuts the door on new players, not on the ones already in it.",
    },
    {
      q: "You put a co-host on a match. What can they do until it is scored?",
      o: [
        "Open any match, as before",
        "Open only that match",
        "Nothing \u2014 they are locked out entirely",
        "Only watch, not score",
      ],
      a: 1,
      why: "It is a job, not a suggestion. Score it, or take them off it, and they are free again.",
    },
    {
      q: "Who can mark a registrant's fee as paid?",
      o: [
        "Anyone in the room",
        "The host, and a Keeper invited as a co-host",
        "Only the player themselves",
        "Only a Head Judge",
      ],
      a: 1,
      why: "A Keeper handles fees once invited as a co-host; the host can too.",
    },
  ];

  // ---- the two exams ----
  //
  // Same engine, different papers. A Judge sitting the Head Judge exam is
  // being asked whether they can RUN the thing, not just score it, so the
  // paper adds the manual questions, runs longer, and has no consolation
  // role: they already hold Judge, and there is no rung between.
  const EXAMS = {
    judge: {
      id: "judge",
      title: "The exam",
      earns: JUDGE_TAG,
      consolation: GUEST_TAG,
      requires: null,
      ms: 1 * 60 * 1000,
      pool: () => RULES_QUESTIONS.slice(),
    },
    head: {
      id: "head",
      title: "The Head Judge exam",
      earns: HEAD_TAG,
      consolation: null,
      requires: JUDGE_TAG,
      // Twice the paper, three times the clock: the manual questions take
      // longer to read than "how many points is a Burst Finish".
      ms: 3 * 60 * 1000,
      pool: () => RULES_QUESTIONS.concat(MANUAL_QUESTIONS),
    },
  };

  // ---- state ----
  let view = "exam";               // exam | ranking | approve

  // The exam is a sitting with a beginning and an end, so it has a phase.
  // `answers` and the clock only mean anything while sitting, and an explicit
  // "intro" is also what lets someone with an application already pending see
  // its status until they deliberately choose to sit it again.
  let phase = "intro";             // intro | sitting | result
  // The paper actually being sat: the exam's questions in THIS attempt's
  // order. Shuffled per sitting, so answers cannot be memorised as a
  // sequence of positions and passed around as "C, A, A, D...".
  let paper = [];
  let examId = "judge";            // which of EXAMS this sitting is
  let answers = [];                // chosen option index per question
  let endsAt = 0;                  // epoch ms the clock runs out
  let ticker = null;               // the one-second interval while sitting
  let outcome = null;              // { finished, answered, score, role }

  let busy = false;                // a write is in flight
  let errorMsg = "";

  let myApp = null;                // judgeApplications/{uid}, once read
  let myAppRead = false;
  let claimed = false;             // the approved-but-unclaimed catch-up ran

  let ranking = null;              // aggregated judgeStats, once read
  let rankingError = "";

  let queue = null;                // every application, for a Head Judge
  let queueError = "";

  function db() {
    try { return firebase.database(); } catch (e) { return null; }
  }
  function tabVisible() {
    const f = document.getElementById("form-judge");
    return !!(f && !f.classList.contains("hidden"));
  }
  function me() {
    return (typeof window.getCurrentUser === "function" && window.getCurrentUser()) || null;
  }
  function amJudge() {
    return !!(typeof window.isJudge === "function" && window.isJudge());
  }
  function amHeadJudge() {
    return !!(typeof window.isHeadJudge === "function" && window.isHeadJudge());
  }
  // The exam can earn either role, so every "do they already have this?"
  // question has to name which one it means.
  function holds(tag) {
    if (tag === GUEST_TAG) {
      return !!(typeof window.isGuestJudge === "function" && window.isGuestJudge());
    }
    // Asked about the top rung this used to fall through to amJudge(), which
    // is true for every Judge — so a Judge looked like they already held Head
    // Judge and was never offered the paper for it.
    if (tag === HEAD_TAG) return amHeadJudge();
    return amJudge();
  }
  function esc(v) {
    return typeof escapeHtml === "function" ? escapeHtml(v) : String(v == null ? "" : v);
  }
  function myName() {
    return (window.getCurrentUsername && window.getCurrentUsername()) || "";
  }
  function keyFor(name) {
    return (name && window.usernameKey) ? window.usernameKey(name) : "";
  }

  // Which exam this account is being offered.
  //
  // Already a Judge? The next paper up is the Head Judge one. Everybody else
  // sits the Judge exam, including a Guest Judge working their way up — the
  // Head Judge exam is a promotion from Judge, not a shortcut past it.
  function currentExam() {
    // Anyone who already holds Judge OR Head Judge gets the Head Judge paper.
    //
    // For a Judge that is the promotion. For a Head Judge it is a refresher:
    // they are at the top, so nothing is filed either way (the result view's
    // `already` check sees to that), but showing them the paper BELOW the one
    // they passed would be odd — and worse, it is the one whose consolation
    // is Guest Judge.
    return EXAMS[(amJudge() || holds(HEAD_TAG)) ? "head" : "judge"];
  }

  function score() {
    return paper.reduce((n, q, i) => n + (answers[i] === q.a ? 1 : 0), 0);
  }
  function answeredAll() {
    return paper.length > 0 && paper.every((_, i) => answers[i] != null);
  }
  function answeredCount() {
    return paper.reduce((n, _, i) => n + (answers[i] != null ? 1 : 0), 0);
  }
  // A judge's calls are not partially right, so the full role takes every
  // answer. The Judge exam has a consolation below it; the Head Judge exam
  // has none, because the person sitting it already holds the rung below.
  function roleFor(s, exam) {
    if (s === paper.length) return exam.earns;
    return exam.consolation;        // null on the Head Judge paper
  }

  // Fisher-Yates. A fresh order every sitting, so the answers cannot be
  // learned as positions — which matters most on the retake-as-often-as-you
  // -like exams here.
  function shuffled(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }
  function clock(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  function startExam() {
    const exam = currentExam();
    examId = exam.id;
    paper = shuffled(exam.pool());
    answers = [];
    outcome = null;
    errorMsg = "";
    phase = "sitting";
    endsAt = Date.now() + exam.ms;
    stopClock();
    // Only the clock's own text is rewritten each second. Re-rendering the
    // whole panel every tick would throw away the scroll position, which on a
    // ten-question page makes the exam unusable.
    //
    // The deadline is an absolute time, so leaving for another sub-tab does
    // NOT pause it — which is the point of a timed exam. Coming back shows
    // however much is left, or the result if the clock ran out meanwhile.
    ticker = setInterval(() => {
      const left = endsAt - Date.now();
      if (left <= 0) { finishExam(); return; }
      const el = document.getElementById("judge-clock");
      if (!el) return;
      el.textContent = clock(left);
      if (left <= Math.round(exam.ms / 4)) el.className = "judge-clock is-low";
    }, 1000);
    render();
  }

  function stopClock() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  // Grades whatever is on the page, whether the clock ran out or they pressed
  // Submit. Leaving a question blank is the one thing that cannot be graded:
  // an unfinished paper earns no role at all, only another go.
  function finishExam() {
    stopClock();
    const exam = EXAMS[examId] || EXAMS.judge;
    const finished = answeredAll();
    const s = score();
    outcome = {
      finished,
      answered: answeredCount(),
      total: paper.length,
      score: s,
      exam: exam.id,
      role: finished ? roleFor(s, exam) : null,
    };
    phase = "result";
    render();
  }

  function shortDate(iso) {
    const d = new Date(iso || "");
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  // ---- reads ---------------------------------------------------------------

  // The applicant's own application. Needed before the Exam tab can say
  // anything useful — without it someone who already applied would be shown
  // the quiz again as though nothing had happened.
  function loadMyApplication() {
    const user = me();
    const d = db();
    if (!user || !d) { myAppRead = true; return Promise.resolve(); }
    return d.ref("judgeApplications/" + user.uid).once("value")
      .then(snap => { myApp = snap.val() || null; myAppRead = true; })
      .catch(() => { myAppRead = true; });
  }

  // Someone whose application was approved while they were away. The public
  // markers are already set; this is the private tag catching up.
  function claimApprovedTag() {
    const user = me();
    const d = db();
    if (claimed || !user || !d) return Promise.resolve();
    if (!myApp || myApp.status !== "approved") return Promise.resolve();
    // Whichever role was approved — claiming the wrong one is what the
    // database rules reject, since they check the application's own role.
    const tag = ROLE_LADDER.includes(myApp.role) ? myApp.role : JUDGE_TAG;
    if (holds(tag)) return Promise.resolve();
    claimed = true;
    return d.ref("users/" + user.uid + "/tags/" + tag).set(true)
      .then(() => {
        // The roles are a ladder, not a collection: moving up to Judge drops
        // the Guest Judge tag rather than wearing both. Removing the key
        // rather than setting it false matters — the rules only let an account
        // set its OWN tag to true, so writing false here would be rejected,
        // while a delete skips validation entirely.
        // Every rung BELOW the one just claimed comes off. Unconditional on
        // purpose: asking holds() first would read the cached profile, which
        // has not necessarily loaded when this runs, and a false reading
        // there leaves the account wearing two badges. Deleting a key that
        // was never set is a no-op.
        const below = rolesBelow(tag);
        if (!below.length) return;
        return Promise.all(below.map(lower =>
          d.ref("users/" + user.uid + "/tags/" + lower).set(null)
            .catch(e => console.warn("Dropping " + lower + " failed:", e && e.message))));
      })
      .then(() => {
        if (typeof window.refreshCurrentProfile === "function") {
          window.refreshCurrentProfile();
        } else {
          window.dispatchEvent(new Event("userprofilechange"));
        }
      })
      .catch(e => {
        claimed = false;
        errorMsg = /permission|denied/i.test((e && e.message) || "")
          ? "Your application is approved but this account can't claim the tag yet. Ask a Developer to deploy the updated database rules."
          : "Couldn't finish setting up your role: " + ((e && e.message) || e);
      });
  }

  // judgeStats is uid -> { tournamentCode -> { role, at, name, event } }, one
  // child per event. Counting children is the whole aggregation — see
  // recordJudgeActivity in tournament.js for why it is shaped that way.
  function loadRanking() {
    const d = db();
    if (!d) { ranking = []; rankingError = "Live sync isn't configured on this build."; return Promise.resolve(); }
    return d.ref("judgeStats").once("value")
      .then(snap => {
        const all = snap.val() || {};
        const rows = Object.keys(all).map(uid => {
          const events = all[uid] || {};
          const codes = Object.keys(events);
          let hosted = 0, cohosted = 0, name = "", last = "";
          codes.forEach(code => {
            const e = events[code] || {};
            if (e.role === "cohost") cohosted++; else hosted++;
            // Names can change; the most recent event wins.
            if (e.name && (!last || String(e.at || "") > last)) { name = e.name; last = String(e.at || ""); }
          });
          return { uid, name, hosted, cohosted, total: codes.length, last };
        });
        // Most events first; a tie goes to whoever hosted more of them, since
        // running an event outright is the bigger job.
        rows.sort((a, b) => b.total - a.total || b.hosted - a.hosted ||
          String(a.name).localeCompare(String(b.name)));
        ranking = rows;
      })
      .catch(e => { ranking = []; rankingError = (e && e.message) || String(e); });
  }

  // Every application, for a Head Judge. The collection read is gated on the
  // Head Judge / Developer tag by the rules, so this is only ever called from
  // the Approvals tab.
  function loadQueue() {
    const d = db();
    if (!d) { queue = []; queueError = "Live sync isn't configured on this build."; return Promise.resolve(); }
    return d.ref("judgeApplications").once("value")
      .then(snap => {
        const all = snap.val() || {};
        queue = Object.keys(all).map(uid => Object.assign({ uid }, all[uid]))
          .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
      })
      .catch(e => {
        queue = [];
        queueError = /permission|denied/i.test((e && e.message) || "")
          ? "This account can't read the applications. Either the database rules haven't been deployed yet, or the Head Judge tag isn't set on it."
          : (e && e.message) || String(e);
      });
  }

  // ---- writes --------------------------------------------------------------

  // Finishing the exam files an application for the role it earned. It does
  // NOT grant anything.
  function apply() {
    const user = me();
    const d = db();
    if (busy) return;
    // Nothing to apply with: the clock beat them, so no role was earned.
    if (!outcome || !outcome.finished || !outcome.role) return;
    if (!user || !d) {
      errorMsg = "Couldn't reach your account. Sign in and try again.";
      render();
      return;
    }
    const name = myName();
    busy = true;
    errorMsg = "";
    render();
    const app = {
      username: name,
      key: keyFor(name),
      score: outcome.score,
      total: paper.length,
      at: new Date().toISOString(),
      status: "pending",
      role: outcome.role,
    };
    d.ref("judgeApplications/" + user.uid).set(app)
      .then(() => {
        myApp = app;
        busy = false;
        // Back to the status card — the sitting has served its purpose.
        phase = "intro";
        outcome = null;
        answers = [];
        render();
      })
      .catch(e => {
        busy = false;
        const msg = (e && e.message) || String(e);
        errorMsg = /permission|denied/i.test(msg)
          ? "The database rules don't accept judge applications yet. Ask a Developer to deploy the updated rules."
          : "Couldn't file your application: " + msg;
        render();
      });
  }

  // A Head Judge's decision. On approval the two public markers go out with
  // it, so the badge and the Battle Royale picker are right immediately —
  // the applicant's private tag follows on their next visit.
  function decide(app, status) {
    const d = db();
    if (busy || !d || !app || !app.uid) return;
    busy = true;
    errorMsg = "";
    render();
    const decidedBy = myName();
    const decidedAt = new Date().toISOString();
    d.ref("judgeApplications/" + app.uid).update({ status, decidedBy, decidedAt })
      .then(() => {
        const key = app.key || keyFor(app.username);
        if (!key) return null;
        // The role the exam earned them, not a fixed one — a Guest Judge
        // application must not quietly hand out the full Judge badge.
        const tag = ROLE_LADDER.includes(app.role) ? app.role : JUDGE_TAG;
        if (status === "approved") {
          const writes = [
            d.ref("profiles/" + key + "/tags/" + tag).set(true),
            d.ref("judges/" + key).set(app.username || key),
          ];
          // A promotion takes the lower badges off at the same time, or they
          // wear both until their own device catches up — and the public
          // badge is the one everyone else sees.
          rolesBelow(tag).forEach(lower => {
            writes.push(d.ref("profiles/" + key + "/tags/" + lower).set(null)
              .catch(() => null));
          });
          return Promise.all(writes);
        }
        // A rejection after a previous approval has to take the markers back
        // out, or the picker would keep offering them. profiles/{key}/tags is
        // what the Battle Royale picker filters on.
        //
        // The judges index is shared: "Judge", "Head Judge", "Guest Judge" and
        // "Keeper" all feed it. Turning down a Guest Judge's bid for Judge
        // must not drop them out of the sub-host typeahead they still belong
        // in, so clear the entry only when nothing is left pointing at it.
        // profiles/{key} is world-readable, which is what makes that checkable
        // from the reviewer's device.
        return d.ref("profiles/" + key + "/tags/" + tag).set(null)
          .then(() => d.ref("profiles/" + key + "/tags").once("value"))
          .then(snap => {
            const tags = snap.val() || {};
            const stillListed = INDEXED_TAGS.some(t => tags[t]);
            if (stillListed) return null;
            return d.ref("judges/" + key).set(null);
          })
          .catch(() => null);
      })
      .then(() => {
        busy = false;
        Object.assign(app, { status, decidedBy, decidedAt });
        render();
      })
      .catch(e => {
        busy = false;
        errorMsg = "Couldn't save that decision: " + ((e && e.message) || e);
        render();
      });
  }

  // ---- views ---------------------------------------------------------------

  // How many applications are still waiting on a decision.
  //
  // Two sources, deliberately. Once the Approvals tab has been opened `queue`
  // is loaded and is the fresher of the two — a decision shows in it
  // immediately, before the database round-trip. Until then the only thing
  // that knows is auth.js's live listener, which runs on every page.
  function pendingCount() {
    if (queue) return queue.filter(a => a && a.status === "pending").length;
    return Number(window.judgePendingCount) || 0;
  }

  function subTabs() {
    const tabs = [
      { id: "exam", label: "Exam" },
      { id: "ranking", label: "Ranking" },
    ];
    // The Approvals tab is for Head Judges and Developers. Hiding it is not
    // the permission — the rules are — but there is no reason to show a tab
    // that can only report that it can't read anything.
    if (amHeadJudge()) tabs.push({ id: "approve", label: "Approvals" });
    const waiting = amHeadJudge() ? pendingCount() : 0;
    // The row is a flex strip sized to its labels, so a third tab needs no
    // help from a column count the way the grid-based rows elsewhere do.
    return `<div class="judge-sub-tabs" role="tablist">${tabs.map(t => {
      // Somebody is waiting on a decision. Shown on the tab itself as well as
      // on the nav badge, because once you are ON this page the nav badge is
      // the thing you have stopped looking at.
      const flag = (t.id === "approve" && waiting > 0)
        ? `<span class="judge-sub-badge" aria-hidden="true">!</span>`
        : "";
      const label = (t.id === "approve" && waiting > 0)
        ? `${t.label} — ${waiting} waiting`
        : t.label;
      return `<button type="button" class="judge-sub-tab${view === t.id ? " active" : ""}${flag ? " has-badge" : ""}"
               data-judge-view="${t.id}" role="tab"
               aria-selected="${view === t.id ? "true" : "false"}"
               aria-label="${esc(label)}">${t.label}${flag}</button>`;
    }).join("")}</div>`;
  }

  function renderQuestions() {
    const graded = phase === "result";
    return paper.map((q, i) => {
      const chosen = answers[i];
      const right = graded && chosen === q.a;
      const wrong = graded && chosen !== q.a;
      return `
        <li class="judge-q${right ? " is-right" : ""}${wrong ? " is-wrong" : ""}">
          <p class="judge-q-text"><span class="judge-q-n">${i + 1}</span>${esc(q.q)}</p>
          <div class="judge-q-options" role="radiogroup" aria-label="Question ${i + 1}">
            ${q.o.map((opt, oi) => `
              <button type="button" class="judge-opt${chosen === oi ? " is-chosen" : ""}${graded && oi === q.a ? " is-answer" : ""}"
                      data-q="${i}" data-o="${oi}" role="radio"
                      aria-checked="${chosen === oi ? "true" : "false"}"
                      ${graded ? "disabled" : ""}>${esc(opt)}</button>`).join("")}
          </div>
          ${graded ? `<p class="judge-q-why">${esc(q.why)}</p>` : ""}
        </li>`;
    }).join("");
  }

  function examView() {
    if (!me()) return `<p class="judge-empty">Sign in to take the judge exam.</p>`;
    if (!myAppRead) return `<p class="judge-empty">Loading…</p>`;
    if (phase === "sitting") return sittingView();
    if (phase === "result") return resultView();
    return introView();
  }

  // What this account already holds, or is waiting on. Shown before a sitting
  // starts and never during one — mid-exam the only thing that matters is the
  // clock.
  function statusHead() {
    const status = myApp && myApp.status;
    const role = (myApp && myApp.role) || JUDGE_TAG;
    if (holds(HEAD_TAG)) {
      return `<div class="judge-status is-judge">You are a Head Judge. You approve new judges from the Approvals tab, you can put a named co-host on each match of a tournament you host, and you count as a Judge everywhere one is needed. This is the top of the ladder \u2014 there is no paper above it.</div>`;
    }
    if (amJudge()) {
      return `<div class="judge-status is-judge">You are a Judge. You can create tournaments, be invited as a co-host, and be picked to oversee a Battle Royale battle.</div>`;
    }
    if (holds(GUEST_TAG)) {
      return `<div class="judge-status is-judge">You are a Guest Judge. You can be invited to co-host and to oversee a Battle Royale battle, but not to create a tournament of your own. Sit the exam again and get every answer right to apply as a full Judge.</div>`;
    }
    if (status === "approved") {
      return `<div class="judge-status is-judge">Approved as ${esc(role)}${myApp.decidedBy ? " by " + esc(myApp.decidedBy) : ""}. Setting up your tag…</div>`;
    }
    if (status === "pending") {
      return `<div class="judge-status is-pending">
                <strong>Application sent — ${esc(role)}.</strong> You scored ${esc(myApp.score)} / ${esc(myApp.total)}
                on ${esc(shortDate(myApp.at))}. A Head Judge reviews it from here.
              </div>`;
    }
    if (status === "rejected") {
      return `<div class="judge-status is-rejected">
                <strong>Not approved${myApp.decidedBy ? " by " + esc(myApp.decidedBy) : ""}.</strong>
                You can sit the exam again and apply again.
              </div>`;
    }
    return "";
  }

  function introView() {
    const exam = currentExam();
    const n = exam.pool().length;
    const mins = Math.round(exam.ms / 60000);
    const head = exam.id === "head";
    const again = !!(myApp || amJudge() || holds(GUEST_TAG));
    return `${statusHead()}
      <div class="judge-intro">
        <h3 class="judge-h">${esc(exam.title)}</h3>
        ${head
          ? `<p>You already hold <strong>Judge</strong>. This is the paper above it: ${n} questions against a
             ${mins}-minute clock, covering the official regulations <em>and</em> the Manual — creating a
             tournament, running it, and what to do when something goes wrong. Read the Manual first; it is
             the Tutorial button beside Open Tournaments.</p>`
          : `<p>${n} questions on the official tournament regulations, against a ${mins}-minute clock. The
             clock starts when you press the button below, and it does not stop if you leave this tab.</p>`}
        <ul class="judge-intro-list">
          ${head
            ? `<li><strong>Every answer right, in time</strong> — you apply as a <em>Head Judge</em>: approve
               new judges, and put a named co-host on each match of a tournament you host.</li>
               <li><strong>Anything less</strong> — nothing is filed and you stay a Judge. There is no rung
               between the two, so this paper has no consolation.</li>`
            : `<li><strong>Every answer right, in time</strong> — you apply as a <em>Judge</em>: create
               tournaments, co-host, and oversee Battle Royale battles.</li>
               <li><strong>All answered in time, not all right</strong> — you apply as a <em>Guest Judge</em>:
               co-host and oversee battles, but not create tournaments of your own.</li>`}
          <li><strong>The clock beats you</strong> — nothing is filed, and you can sit it again straight away.</li>
        </ul>
        <p class="judge-note">${holds(HEAD_TAG)
          ? "You already hold Head Judge, so nothing is filed \u2014 sit it whenever you want to check yourself against it. "
          : ""}The questions come in a different order every sitting. ${head
          ? "A Head Judge approves the application before the role is granted, and approving it drops your Judge tag — the roles are a ladder, not a collection."
          : "Either way, a Head Judge approves the application before the role is granted."}</p>
      </div>
      <div class="judge-actions">
        <button type="button" class="btn" id="judge-start">${again ? "Sit the exam again" : "Start the exam"}</button>
      </div>`;
  }

  function sittingView() {
    const exam = EXAMS[examId] || EXAMS.judge;
    const warnAt = Math.round(exam.ms / 4);
    const left = endsAt - Date.now();
    return `
      <div class="judge-clock-bar">
        <span class="judge-clock-label">Time left</span>
        <span class="judge-clock${left <= warnAt ? " is-low" : ""}" id="judge-clock">${clock(left)}</span>
        <span class="judge-clock-count" id="judge-answered">${answeredCount()} / ${paper.length} answered</span>
      </div>
      <ol class="judge-quiz">${renderQuestions()}</ol>
      <div class="judge-actions">
        <button type="button" class="btn" id="judge-submit">Submit answers</button>
      </div>`;
  }

  function resultView() {
    const o = outcome || { finished: false, answered: 0, score: 0, role: null };
    const n = o.total || paper.length;
    let card;

    if (!o.finished) {
      // The one outcome that earns nothing at all. Deliberately not graded as
      // a Guest Judge pass: leaving questions blank says nothing about whether
      // the answers would have been right.
      card = `<div class="judge-result is-fail">
          <strong>Time's up — ${o.answered} of ${n} answered.</strong>
          An unfinished paper earns no role. The correct answers are below — read them and sit it again.
        </div>`;
    } else {
      const sat = EXAMS[o.exam] || EXAMS.judge;
      const perfect = o.score === n;
      const already = !!o.role && holds(o.role);
      // Two different "nothing to apply for" cases. On the Judge paper, a full
      // Judge who drops a question must not be able to talk themselves down
      // into a Guest Judge application. On the Head Judge paper there IS no
      // lesser role, so an imperfect sitting simply earns nothing.
      const noConsolation = !perfect && !sat.consolation;
      const demotion = !perfect && sat.id === "judge" && amJudge();
      const waiting = !!(myApp && myApp.status === "pending");
      const canApply = !!o.role && !already && !demotion && !noConsolation && !waiting;
      card = `<div class="judge-result ${perfect ? "is-pass" : "is-partial"}">
          <strong>${o.score} / ${n} — ${perfect ? "a perfect paper." : `${n - o.score} wrong.`}</strong>
          ${perfect
            ? `You qualify to apply as a ${esc(sat.earns)}.`
            : noConsolation
              ? `A Head Judge paper has to be perfect \u2014 you stay a Judge. Read the Manual and sit it again.`
              : "You qualify to apply as a Guest Judge \u2014 co-hosting and Battle Royale, but not creating tournaments of your own. Sit it again and get every answer right to apply as a full Judge."}
          ${demotion ? " You already hold the full Judge tag, so there is nothing to apply for here." : ""}
          ${already && !demotion ? ` You already hold ${esc(o.role)}.` : ""}
          ${waiting ? " You already have an application waiting on a Head Judge." : ""}
          ${canApply && busy ? " Sending…" : ""}
          ${canApply && !busy ? `<button type="button" class="btn" id="judge-apply">Apply as ${esc(o.role)}</button>` : ""}
        </div>`;
    }

    return `${card}
      <ol class="judge-quiz">${renderQuestions()}</ol>
      <div class="judge-actions">
        <button type="button" class="btn" id="judge-again">Sit the exam again</button>
      </div>`;
  }

  function rankingView() {
    if (ranking === null) return `<p class="judge-empty">Loading…</p>`;
    if (rankingError) return `<p class="judge-error">${esc(rankingError)}</p>`;
    if (!ranking.length) {
      return `<p class="judge-empty">No events counted yet. A judge is credited here when a tournament they
              hosted or co-hosted finishes and is archived.</p>`;
    }
    const mine = me() && me().uid;
    return `
      <p class="judge-note">Counted when a tournament finishes and is archived. Co-hosting counts only if you
      actually opened the room — being listed as a sub-host isn't enough.</p>
      <ol class="judge-rank">
        ${ranking.map((r, i) => `
          <li class="judge-rank-row${r.uid === mine ? " is-me" : ""}">
            <span class="judge-rank-n">${i + 1}</span>
            <span class="judge-rank-name">${esc(r.name || "Unnamed judge")}</span>
            <span class="judge-rank-split">${r.hosted} hosted · ${r.cohosted} co-hosted</span>
            <span class="judge-rank-total">${r.total}</span>
          </li>`).join("")}
      </ol>`;
  }

  function approveView() {
    if (!amHeadJudge()) return `<p class="judge-empty">Head Judges only.</p>`;
    if (queue === null) return `<p class="judge-empty">Loading…</p>`;
    if (queueError) return `<p class="judge-error">${esc(queueError)}</p>`;

    const pending = queue.filter(a => a.status === "pending");
    const decided = queue.filter(a => a.status !== "pending").reverse();

    // The banner and avatar are fetched after the markup lands — see
    // hydrateApplicantFaces. `data-face` is what pairs an empty frame with the
    // profile that fills it.
    const card = (a, showActions) => {
      const key = a.key || keyFor(a.username);
      const guest = a.role === GUEST_TAG;
      const head = a.role === HEAD_TAG;
      return `
      <li class="judge-app${a.status === "approved" ? " is-approved" : ""}${a.status === "rejected" ? " is-rejected" : ""}"
          data-face="${esc(key)}">
        <div class="judge-app-banner" aria-hidden="true"></div>
        <div class="judge-app-body">
          <span class="judge-app-avatar" aria-hidden="true"></span>
          <div class="judge-app-who">
            <span class="judge-app-name">${esc(a.username || a.uid)}</span>
            <span class="judge-app-meta">
              <span class="judge-app-role${guest ? " is-guest" : ""}${head ? " is-head" : ""}">${esc(a.role || JUDGE_TAG)}</span>
              <span class="judge-app-score">${esc(a.score)} / ${esc(a.total)}</span>
              <span class="judge-app-date">${esc(shortDate(a.at))}</span>
            </span>
          </div>
          ${showActions
            ? `<div class="judge-app-actions">
                 <button type="button" class="judge-app-btn is-approve" data-approve="${esc(a.uid)}" ${busy ? "disabled" : ""}>Approve</button>
                 <button type="button" class="judge-app-btn is-reject" data-reject="${esc(a.uid)}" ${busy ? "disabled" : ""}>Reject</button>
               </div>`
            : `<span class="judge-app-verdict">${a.status === "approved" ? "Approved" : "Rejected"}${a.decidedBy ? " · " + esc(a.decidedBy) : ""}</span>`}
        </div>
      </li>`;
    };

    return `
      <p class="judge-note">Each row says which role the exam earned them — a perfect paper asks for Judge,
      anything less asks for Guest Judge. Approving grants that role and nothing more. The badge and the
      Battle Royale picker update at once; the tag itself lands on their account the next time they open
      the app.</p>
      <h3 class="judge-h">Waiting${pending.length ? ` (${pending.length})` : ""}</h3>
      ${pending.length
        ? `<ul class="judge-apps">${pending.map(a => card(a, true)).join("")}</ul>`
        : `<p class="judge-empty">Nothing waiting.</p>`}
      ${decided.length
        ? `<h3 class="judge-h">Decided</h3><ul class="judge-apps">${decided.slice(0, 30).map(a => card(a, false)).join("")}</ul>`
        : ""}`;
  }

  function render() {
    const root = document.getElementById("judge-content");
    if (!root) return;

    const body = view === "ranking" ? rankingView()
      : view === "approve" ? approveView()
      : examView();

    root.innerHTML = `${subTabs()}
      ${errorMsg ? `<p class="judge-error">${esc(errorMsg)}</p>` : ""}
      <div class="judge-panel">${body}</div>`;

    root.querySelectorAll("[data-judge-view]").forEach(btn => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.judgeView;
        if (next === view) return;
        view = next;
        errorMsg = "";
        render();
        ensureDataFor(next);
      });
    });

    root.querySelectorAll(".judge-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        if (phase !== "sitting") return;
        answers[Number(btn.dataset.q)] = Number(btn.dataset.o);
        // Repainting is the simplest way to restate ten questions' worth of
        // selected state, but on its own it throws the page back to the top on
        // every tap — unusable on a phone, and worse against a clock. Put the
        // scroll back where it was.
        const y = (typeof window.scrollY === "number") ? window.scrollY : null;
        render();
        if (y !== null && typeof window.scrollTo === "function") window.scrollTo(0, y);
      });
    });
    const on = (sel, fn) => {
      const el = root.querySelector(sel);
      if (el) el.addEventListener("click", fn);
    };
    on("#judge-start", startExam);
    on("#judge-again", startExam);
    on("#judge-submit", () => {
      const unanswered = paper.findIndex((_, i) => answers[i] == null);
      if (unanswered !== -1) {
        alert(`Question ${unanswered + 1} hasn't been answered yet. The clock is still running.`);
        return;
      }
      finishExam();
    });
    on("#judge-apply", apply);

    root.querySelectorAll("[data-approve]").forEach(btn => {
      btn.addEventListener("click", () => {
        const app = (queue || []).find(a => a.uid === btn.dataset.approve);
        if (app) decide(app, "approved");
      });
    });
    root.querySelectorAll("[data-reject]").forEach(btn => {
      btn.addEventListener("click", () => {
        const app = (queue || []).find(a => a.uid === btn.dataset.reject);
        if (app) decide(app, "rejected");
      });
    });

    hydrateApplicantFaces(root);
  }

  // Fill in each applicant's photo and banner once the rows exist.
  //
  // Done after the markup rather than inside it because the images come from
  // ProfileCache, which is asynchronous and shared — rows paint immediately
  // and the faces arrive when they arrive. A profile with neither just keeps
  // the plain card, which is why the frames are styled to look deliberate
  // when empty rather than broken.
  function hydrateApplicantFaces(root) {
    if (!root || !window.ProfileCache) return;
    root.querySelectorAll("[data-face]").forEach(li => {
      const key = li.getAttribute("data-face");
      if (!key) return;
      window.ProfileCache.row(key).then(r => {
        if (!r) return;
        if (r.banner) {
          const b = li.querySelector(".judge-app-banner");
          if (b) {
            b.style.backgroundImage = `url("${r.banner}")`;
            b.style.backgroundPosition = r.bannerPos || "50% 50%";
            li.classList.add("has-banner");
          }
        }
        if (r.photo) {
          const av = li.querySelector(".judge-app-avatar");
          if (av) {
            av.style.backgroundImage = `url("${r.photo}")`;
            av.style.backgroundPosition = r.photoPos || "50% 50%";
            li.classList.add("has-photo");
          }
        }
      }).catch(() => {});
    });
  }

  // Each sub-tab loads its own data the first time it is opened, so someone
  // who only ever takes the exam never pays for the ranking read.
  function ensureDataFor(which) {
    if (which === "ranking") {
      if (ranking === null) loadRanking().then(render);
    } else if (which === "approve") {
      if (queue === null) loadQueue().then(render);
    } else if (!myAppRead && me()) {
      loadMyApplication().then(() => claimApprovedTag()).then(render);
    }
  }

  // ---- entry point (called by core.js when the tab is active) ----
  window.renderJudge = function renderJudge() {
    if (!tabVisible()) return;
    render();
    ensureDataFor(view);
  };

  // The profile arrives asynchronously after sign-in, so repaint when it
  // lands — otherwise someone who opens the page directly is told to sign in
  // when they already are, and the Approvals tab never appears for a Head
  // Judge whose tags hadn't loaded yet.
  window.addEventListener("userprofilechange", () => {
    if (!tabVisible()) return;
    render();
    ensureDataFor(view);
  });

  // An application can land while the page is open — on the Exam tab, say —
  // and the "!" has to appear without a reload.
  window.addEventListener("judgequeuechange", () => {
    if (tabVisible()) render();
  });
})();
