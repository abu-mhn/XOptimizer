// docs/settings/settings.js — Settings tab extras.
//
// "Show Features" button: opens a popup with a copy-pasteable plaintext
// list of every user-visible feature in X Optimizer. Update FEATURES_TEXT
// whenever a meaningful new capability ships so the dump stays accurate.
(function initFeaturesPopup() {
  const FEATURES_TEXT = `X Optimizer — Features

Dashboard
- Auto-sliding carousel: Combo of the Day, Heaviest Bey, Max ATK / DEF / STA
- Combo names computed exactly like the calculator (e.g. BULLETGRIFFONY) — codename + ratchet name + bit codename
- Tap any part image for a larger preview
- Best Parts carousel: top 3 most-used parts per type (Blade, Lock Chip, Ratchet, Bit, etc.) from the most recently FINISHED tournament, ranked 1st (gold) / 2nd (silver) / 3rd (bronze) — sourced from the top entry in Tournament History (any format: Swiss, Round Robin, or Single Elimination)
- Best Parts survive a tournament reset — once a tournament finishes, its cached entry in Tournament History keeps feeding the panel until a newer tournament finishes on top of it
- Respects calculator constraints: Bullet Griffon's built-in ratchet (no ratchet slot), Clock Mirage's -5 ratchet requirement
- Combo of the Day is seeded by today's date — every visitor sees the same combo until local midnight

Calculator
- Three combo modes: Standard, CX (Custom), CX Expand
- One combined fieldset per mode (Top + Bottom merged) for a cleaner form
- Searchable part dropdowns
- Action buttons (Calculate / Reset / Random) show icon + label inline
- Additional button modes: Random, Meta
- Meta picker for Clock Mirage picks a -5 ratchet uniformly at random (no -5 ratchet is flagged meta, so the previous meta-first preference was dead code); same rule now applies to Test mode's auto-generated decks
- CX / CX Expand results show the lock chip, blade(s) and assist blade assembled into one combined image (also used in the Deck, History and Dashboard)
- Tap the combined blade to flip through its parts in an auto-sliding, swipeable carousel
- Polished result card: framed stat-chart, part-thumbnail and data panels, a spec-sheet stats table (muted labels, bold right-aligned values), and refined action buttons
- The part mode renders as a tappable chip (tap to cycle its mode); a downloaded / shared photo flattens it to plain text so the image stays clean
- Share the result as an image — Web Share on mobile, download fallback on desktop

Library
- Search Beyblade X parts by name
- Filter by part type: Blades, Bits, Ratchets, Assist Blades, Main Blades, Metal Blades, Over Blades, Lock Chips
- Sort by Name, ATK, DEF, STA, Weight, Height
- Tap any part image for a larger preview

Deck (3 Slots)
- Multiple named decks with an active selector
- Shuffle slot order
- Reset / clear the deck
- Download the deck as a PNG (background follows your theme)
- Share the deck as an image — Web Share on mobile, download fallback on desktop
- Copy a deck to paste into a tournament registration
- Paste a copied deck straight into the active deck with the Paste button
- Edit any slot's combo in place — tap the pencil to rebuild it: swap parts or switch its mode (BX / CX / CX Expand)
- Each slot is its own card with a collapsible Stat Graph (tap + / − to open) that draws a bar or radar chart, following your Settings → Stat display choice
- Switch a multi-mode part's mode straight from the slot — parts like Operate (Defense / Attack) show an inline mode chip; tap it to switch and the combo's thumbnail + stats recompute on the spot. The pencil editor has the same per-part mode control
- Ratchet-bits (Turbo, Operate) show their thumbnail in the slot instead of a blank tile
- On desktop a vertical mouse wheel scrolls the part rows, the toolbar and the deck switcher sideways (touch swipe still works)
- Cross-device sync when signed in — decks follow your account everywhere

Tournament
- Three formats: Swiss, Round Robin, Single Elimination
- Round Robin: everyone in a group plays everyone else exactly once; rounds are fixed by group size (N players = N-1 rounds, or N with a bye each round when odd)
- Round Robin reuses the Swiss group stage, standings and Top-N knockout — only the per-round pairing differs (fixed everyone-vs-everyone schedule vs. Swiss standings-based pairing)
- A Round Robin bye (forced by an odd group size) is a sit-out, not a win — only real matches count toward standings and the bracket seeding
- Pick Swiss or Round Robin, then choose whether to add a knockout bracket (any top-N) or finish on group records. The knockout size is asked at create time AND any time the host switches an existing tournament into a knockout format mid-registration — Top 4 / 8 / 16 / 32 presets plus a custom number input (2-64). Non-power-of-2 sizes (Top 10, Top 12, …) are padded with byes via the same engine single-elim uses
- Single Elimination placement depth — set how many finishers to rank to any number (not just Top 8 / 12 / 16) via a free-form picker that matches the Knockout Bracket Size layout; the bracket builds the matching consolation / loser-bracket matches and ranks as deep as its structure allows. Editable from the registration screen
- Configurable groups: 2, 3, or 4 (Swiss and Round Robin)
- Configurable rounds per group for Swiss: 3, 4, 5 (Round Robin derives rounds from group size)
- Hosting requires a free email account (Settings → Account, or prompted on Create Tournament)
- Every tournament is ranked automatically — no host password
- Self-registration via the Open Tournaments lobby (no manual name list)
- Deck is mandatory for account registrations — Register Myself and any signed-in lobby registrant must fill all 3 deck slots AND every required part in each slot (blade + ratchet + bit, plus any mode-specific parts for CX / CX Expand) before submit. A blade-only or partially built slot is rejected with a "Slot N is missing parts" message naming the offending slots. Guests (Register Others and the lobby Guest flow) can skip the deck entirely or save a partial deck; the register popup swaps in a "Deck is optional for guests" hint, and their empty deck is excluded from the finish parts-usage pie chart
- Tournaments you host show a "Hosting" badge in the Open Tournaments lobby when you're signed in
- Running tournaments stay listed in the Open Tournaments lobby with an "In progress" badge — registration is closed, but co-hosts and viewers can still join
- My Tournaments: a signed-in host is dropped straight back into the tournament they host on any device — the room index follows your account, not the device (a pick list appears only if you host more than one)
- Join from the lobby as Participant (register name + deck) or Viewer (watch only)
- Joining as Participant asks "Sign in" or "Become Guest" — signed-in players earn ranking points on finish; guests play normally but stay off the leaderboard
- Become Guest opens the bulk-guests popup — enter your name (and any friends, one per line) and every entry is created as a deck-less guest in a single write; you're then dropped into the tournament view as participant. No account needed, not even anonymous sign-in: registrants are flagged isGuest with no createdBy, accepted by the relaxed rule's tail clause. If the Anonymous provider IS enabled in the Firebase project, it's used silently for createdBy ownership stamping, but not required
- Sign in to a tournament you're already registered in (matched on your username) and the deck-registration step is skipped — you go straight into the participant view
- Signing in as the room's host (matched on hostUid) drops you straight into the host view, even on a fresh device
- Signing out while inside a tournament returns you to the Open Tournaments lobby; the room itself stays alive in Firebase, so signing back in puts you back inside
- Sub-hosts: the host lists co-host usernames in a "Sub-hosts" popup — anyone signed in with a listed username gets full co-host powers (no host code) and joins straight as co-host from the lobby
- The room badge shows the host and the room's designated sub-hosts
- Hosts AND co-hosts can play (+ Register Myself), start the tournament, add participants, and remove registrants
- Player profile photos show beside the name everywhere a player appears — registrant rows, group + bracket match cards, group standings, and the live scoreboard — pulled from a public profiles index so it works for every host / co-host (a silhouette shows for free-form Bulk Guests / Test names that have no account)
- Register Myself pre-fills your account's username and locks the name field, so no one can register under someone else's name from your device
- Bulk Guests (host / co-host AND registered participants): the single "add others" path. Paste a name list (one per line) and every entry is created as a deck-less guest in one Firebase update, so they all appear together in the registrants list. Single-add works too — type one line for one guest. Max 50 names per batch; duplicates within the batch and against existing registrants are auto-skipped. These entries are flagged isGuest (no account attached) and don't earn global ranking points; Register Myself stays tied to your account and does earn points
- QR button in the Open Tournaments header shows a scannable QR code that opens /tournament/ on any phone
- Tutorial button next to QR / Refresh opens a two-tab walkthrough — Sign In and Guest. Each tab shows a single demo gif (assets/tutorial/signin/signin.gif and guest/guest.gif) with a one-line caption. No carousel, no swipe, no auto-advance — the gifs walk through the flow on their own
- Header buttons (Tutorial / QR / Refresh / Create Tournament) sit on a single horizontal row with an invisible scroller
- Only accounts tagged "Judge" can Create Tournament — the button hides entirely for signed-out or non-Judge accounts
- Sub-hosts typeahead lists only accounts tagged "Judge" (via a public judges index synced from the Developer page)
- Lobby cards flag a tournament you've been invited to co-host with a small "!" alert badge
- Edit the format while waiting for players — tap the format chip to switch between Swiss, Round Robin and Single Elimination, or the groups / rounds chips to adjust them; registrants are kept, no reset needed. Switching INTO a knockout format (Swiss + Top N or Round Robin + Top N) re-opens the Top-N picker so the host picks the bracket size right there — same flow as create time
- Test button: bulk-adds synthetic participants for QA — visible only to accounts tagged "Tester"
- Auto-build (Test) button in the Register popup — Tester-only. Prompts for one of the nine achievements and fills the 3-slot deck with a pre-built combo guaranteed to satisfy that achievement's win condition. Lets a tester verify each achievement's creditOnWin end-to-end without hand-rolling parts
- Copy Names button (Tester-only, host / co-host): copies every registrant's name to the clipboard, one per line — a QA aid; the button flashes the copied count
- Test decks obey "one of each part per deck" across all 3 slots (only light lock chips can repeat; Emperor / Valkyrie cannot)
- Test deck mode mix is weighted realistic: ~75% Standard, ~13% CX, ~12% CX Expand
- Test registrants never earn global ranking points or appear on the leaderboard
- Edit a registrant in place — tap their name to change the name or rebuild their deck. Account-based registrations keep the name locked on edit (it keys their ranking entry); only guest / Register Others entries stay name-editable. Participants can tap their OWN row to re-open the edit popup too (matched by createdBy = auth.uid for signed-in users, or per-room localStorage tracking for unauthed Become Guest entries) — no need to ping the host
- Each registrant row carries a deck-status badge so the host can spot problem entries at a glance: green "Deck ✓" when every slot has every required part for its mode (standard / CX / CX Expand), amber "Incomplete" when at least one slot is missing a required part (tooltip names the offending slot numbers), red "No deck" when all 3 slots are empty, or red "Banned parts" when any slot contains a part on the room's Banned Parts list (tooltip names the banned parts + slot numbers). The banned-parts check is cross-field — a banned name (e.g. a banned ratchet) flags the deck no matter which slot field it appears in, so registrants who entered BEFORE a ban was added are flagged automatically without re-asking them to edit. Bullet Griffon slots pass "Deck ✓" without a ratchet (BG has a built-in ratchet, so its ratchet field is optional)
- Leave Room also unregisters you — tapping the leave button during the registering phase removes any registrant entries the device owns (matched by createdBy = auth.uid, or by per-room localStorage tracking for unauthed Become Guest entries). No need to ping the host to remove your name. Hosts use the existing × next to each name (with an "Are you sure you want to remove [name]?" confirm to prevent accidental boots) — and when the host removes you that way, your device auto-disconnects from the room with a clear notice so no stale session is left open
- Pre-Start deck check — tapping Start Tournament sweeps every registrant and surfaces deck problems in one combined prompt: account registrants with no deck, anyone with incomplete slots (and which slots), and anyone whose deck contains banned parts (and which parts). Guests with no deck are intentionally skipped (deck is optional for guests). The host can fix the listed issues or override and start anyway
- Add participants in bulk during round 1 — paste a list of names (one per line) into the + Add popup and every entry is created as a deckless guest. Swiss / Round Robin slots them in as round-1 free wins (or pairs them against existing byes), no reset; Single Elim confirms once and regenerates the bracket with every new name included
- Remove participants before round 2 — the − Remove button opens a list of every player with × buttons. Confirming removes the chosen player and regenerates the format from the remaining names (same gate as Add — round 1 only). Round-1 matches that have been scored are lost in the regen and the host is warned before that happens
- Toolbar buttons show icon + text labels (Share / Sub-hosts / + Add / − Remove / Reset or Leave) and sit on a horizontal row with an invisible scroller, so the row scrolls sideways on narrow phone screens instead of clipping or wrapping
- Rename any participant after the tournament starts — tap their name in a group's Standings
- Adjust the total round count mid-tournament — tap "Round X / Y" in a group header; already-played rounds are kept
- Registered decks pre-fill every match; judges can override per match
- CX / CX Expand decks paste from the Deck tab without losing parts (lock chip / main blade / assist blade preserved)
- Bey Check slots show just "Slot 1 / 2 / 3" with an invisible-scrollbar part row (swipe still works)
- Swiss + Top N auto-generates the knockout bracket from group standings the moment every group's final round completes — top finishers from each group are pooled, sorted by Swiss tiebreakers, and seeded into a standard fold bracket (1 vs N, 2 vs N-1, …). Non-power-of-2 N pads with byes that auto-advance, so Top 10 / Top 12 work the same as Top 8 / Top 16. Legacy Top 8 tournaments already in flight keep their original QF/SF/F structure
- Scoreboard round counter above VS, advancing every 3 score taps
- Tilt-activated scoreboard on mobile (rotate to landscape)
- Match-start alerts — when a host goes LIVE on a match, every other device connected to the room (host, co-hosts, participants, viewers — everyone in the room) pops an in-app toast in the top-right naming the players + round / group, with a "You're up!" green highlight when the signed-in user's username is one of the players. Tap to dismiss or auto-dismisses after 8s. Optional system notifications via the "Turn on alerts" button in the first toast — once Notification permission is granted, every later match-start also fires an OS-level notification so users still get pinged when the phone is locked or the browser tab is in the background (mobile Chrome / Edge / Brave supported; iOS Safari needs the site installed as a PWA via Add to Home Screen). A Match Alerts row in Settings shows the current state (unsupported / blocked / off / on) and lets you turn alerts on, or mute them per device without revoking the permission
- Share button opens a popup for date, time, stadium (Xtreme / Infinity / Double Xtreme), rule (Official / Unofficial), and remark — date renders as "14 May 2026 (Thursday)"
- Sharing opens the OS native share sheet via navigator.share when available (mobile Chrome / Edge / Brave / Safari, recent desktop Edge) — pick WhatsApp, Discord, Messages, etc. straight from the picker. Desktop browsers without the Web Share API fall back to clipboard copy (button flashes a thumbs-up) so you can paste anywhere yourself
- Share message keeps it short — event details, the registration link, and a pointer to the in-app Tutorial button for how to join (no participant list, no step-by-step register text)
- Past tournaments stay viewable in history after reset (cached snapshot)
- Cleaner finish view: once a tournament reaches "Tournament Complete" the running-view toolbar drops the Share, Co-hosts and Add Participant buttons — only the Close button stays, since none of those actions apply after the final is decided
- Parts-usage pie charts at tournament end as an auto-sliding carousel (theme-aware palette)

Achievement
- New tab visible to any signed-in account — sits between Profile and Revox in the tab bar. Each achievement is a progress card on the tab (icon + title + description + bar + N / 100 count); once the count hits 100 the card flips to "Unlocked · [Theme name] theme". The card subscribes to Firebase live, so counters tick up in real time as matches credit (no manual reload)
- Forward-only tracking — counters start at 0 for every account on launch and only matches scored from this version onward contribute. Past tournament history is not backfilled
- Dragon Tamer — win 100 matches while your deck includes a part named Dran, Drake, Dragoon, Wyvern, Bahamut or Ragna (any slot, any field). Awards the "Dragon Tamer" profile tag + unlocks the Dragon Tamer theme (warm reds + ember gold)
- Dragon Slayer — defeat 100 opponents whose deck included a part named Dran, Drake, Dragoon, Wyvern, Bahamut or Ragna, while your OWN deck contains any Knight-named part (the knight slays the dragon). Awards the "Dragon Slayer" profile tag + unlocks the Dragon Slayer theme (steel blue + silver)
- Lone Wolf — win 100 matches where (1) your deck contains exactly one Wolf-named part AND (2) the slot holding that Wolf part is the only one of its combo type in the deck (Balance variants count as one type). If the Wolf slot is Stamina, neither other slot can be Stamina, etc. — the wolf walks its own type. Awards the "Lone Wolf" profile tag + unlocks the Lonewolf theme (slate gray + moon teal)
- Rush Hour — win 100 matches where at least one slot pairs a Clock Mirage blade with a Rush-named bit (Rush Flat / Rush Dash / etc.) in the SAME slot. That's the meta combo Clock Mirage is built around. Awards the "Rush Hour" profile tag + unlocks the Rush Hour theme (deep amber + traffic-light red)
- King of The Jungle — win 100 matches where exactly ONE deck slot carries a Leon-named part (the lion king) AND the OTHER two slots each carry at least one part named Rhino, Fox, Wolf, Viper, Tiger, Bear or Goat (the pride that flanks him). Awards the "King of The Jungle" profile tag + unlocks the King of The Jungle theme (savanna gold + jungle green)
- Sharknado — win 100 matches where at least one slot has a Shark-named part AND that slot classifies as a Balance-type combo (no single stat hitting 100). Awards the "Sharknado" profile tag + unlocks the Sharknado theme (deep ocean blue + lightning yellow)
- Sorcerer Supreme — win 100 matches where every one of your 3 deck slots contains at least one Wizard-named part (a full wizard council, no non-wizard slots). Awards the "Sorcerer Supreme" profile tag + unlocks the Sorcerer Supreme theme (mystical violet + arcane gold)
- Paleonerd — win 100 matches where every one of your 3 deck slots carries a Tyranno / Tricera / Ptera / Mammoth or Brachio part. Awards the "Paleonerd" profile tag + unlocks the Paleonerd theme (amber fossil + Jurassic jungle green)
- King of All Types — win 100 matches with a Bullet Griffon slot tuned out of its default Balance configuration into Attack / Defense / Stamina (any non-Balance combo type). Bullet Griffon's built-in ratchet leaves the slot at BG-blade + bit; picking a bit that pushes a stat ≥ 100 is what flips the slot into a non-Balance type. Awards the "King of All Types" profile tag + unlocks the King of All Types theme (platinum silver + royal blue)
- Storage lives at /achievements/{uid} (keyed by Firebase Auth UID). Reads are private to the user (or Developer); writes happen on the scoring device once a match is finalised. The tag is mirrored onto the user's profile the next time they sign in, gated by a Firebase rule that only lets the player self-claim a title when the matching achievement node is already flagged awarded
- Guests and tied matches don't credit any achievement (same gate as global ranking points)
- Format-agnostic — Swiss groups, Round Robin groups, knockout brackets (Swiss + Top N) and Single Elimination matches all run the same scoring path. Every scored win where the winner is a non-guest registrant runs the achievement check on the winner's match deck
- Deck resolution falls back through three sources so a host who scores a match without first opening Bey Check doesn't silently skip achievement credit: (1) the per-match Bey Check deck if it was saved, (2) the player's registered deck from when they signed up, (3) the most recent prior-match deck (legacy pre-self-registration tournaments)

Revox
- Dedicated tab and theme for accounts tagged "Revox Admin" (full edit); "Revox Member" accounts see the tab view-only
- The Revox theme is applied automatically the first time a Revox Admin / Revox Member account is used on a device — after that it's a normal pick in the theme menu, so you can switch to any other theme and it sticks
- Member ranking by points — no password, the account tag is the key
- Add Result popup: pick the tournament, date and placing — the placing sets the points (Top 8 scoring: 1st = 8 pts down to 8th = 1)
- Add Result's Name dropdown lists accounts tagged "Revox Member" or "Revox Admin" (sourced from the public revoxAccounts index — maintained automatically when a Developer adds/removes either tag, and back-filled whenever a Developer opens the Developer tab), merged with anyone who already has a ranking entry
- Auto-entry: any participant whose account is tagged "Revox Member" or "Revox Admin" (matched via the public revoxAccounts index) and finishes in the Top 8 of a ranked tournament is added to the Revox ranking automatically with placing-based points (1st = 8 pts down to 8th = 1) — guests and test registrants are skipped, and each placing is awarded only once per tournament
- Add a result onto an existing member straight from their row, or as a brand-new member
- Hover a member's name for their profile card; tap it for their full tournament history
- Each member row shows their profile photo beside the name and their profile banner as the row background (top 3 keep a gold / silver / bronze tint)
- The history popup leads with the member's profile (banner, photo, tags, bio), then every event they joined, newest first
- Revox Admins can edit or delete any recorded result — the member's points re-total automatically

Battle Pass
- Bluetooth connection to BEYBLADE_TOOL01 launcher (Chrome / Edge on desktop or Android, Bluefy browser on iOS)
- Connect, Disconnect and Clear Data buttons each carry an icon — link, unlink, and a trash can — so the action reads at a glance

Buzz Bey
- Local, International, and Japan video embeds
- Region sub-tabs show a recognisable icon: KLCC (Local), globe (International), Mt. Fuji (Japan)

History
- Last 3 calculated combos
- Tournament history with role badges: Host, Co-host, Participant, Viewer
- Clickable entries open final placements (cached when the live room is gone)
- Sub-tabs show icons next to "Last 3 Combos" and "Tournaments" for quick scanning

Settings
- Themes: Dark, Light, Space, Tropical, Stormy, Monochrome, Love, Forest (plus Revox, for Revox accounts)
- Medal themes: Gold, Silver and Bronze are reward themes — each is unlocked only while the account holds the matching medal tag (top 3 of the tournament ranking); the menu entry appears when the medal is earned and disappears when it's lost, reverting to Dark if that medal theme was active
- Achievement themes: Dragon Tamer (warm reds + ember gold), Dragon Slayer (steel blue + silver), Lone Wolf (slate gray + moon teal), Rush Hour (deep amber + traffic-light red), King of The Jungle (savanna gold + jungle green), Sharknado (ocean blue + lightning yellow), Sorcerer Supreme (mystical violet + arcane gold), Paleonerd (amber fossil + Jurassic jungle green) and King of All Types (platinum silver + royal blue). Each appears in the theme menu only while the matching achievement tag is held (awarded at 100 wins — see the Achievement tab); same demote-to-Dark behavior as the medal themes if the tag is ever lost
- Developer theme preview: accounts tagged "Developer" see every locked theme entry in the menu (Revox, all three Medal themes, all Achievement themes) regardless of whether they hold the matching tag. The demote-on-revoke logic is also bypassed for Developers, so picking a preview theme sticks until they switch manually. Useful for QA and screenshots; non-Developer accounts still follow the normal tag-gate
- Stat display: Bar or Radar
- Additional button mode picker (Random / Meta)
- Account: sign up / sign in with username or email + password, forgot-password reset, sign out
- Match Alerts: per-device toggle for tournament match-start notifications — shows the current state (unsupported on this browser / blocked by browser / off / on) with a single button to turn alerts on (prompts for Notification permission) or mute them. Works alongside the in-app toast: muting only silences the system-level OS notification
- Show Features (this list)

Profile
- Your own profile tab — the profile photo doubles as the tab icon
- Upload a photo and a banner (tap the image to change it), set a username and a short bio
- Photo / banner crop editor — after upload, a popup opens with the image inside a circle (photo) or 3:1 frame (banner). Drag to pan, pinch / scroll / slider to zoom (1x–4x); Apply bakes the visible crop into the saved image so the display is a plain object-fit:cover with no per-surface transforms. Reset on every fresh upload
- Animated GIF photo / banner — picking a .gif (or any image/gif MIME) skips the canvas crop editor (re-encoding would freeze the animation) and saves the original bytes as-is. A preview popup shows the GIF playing in the target frame shape with the actual file size; tap Use this to commit. Caps: photo ~375 KB raw, banner ~750 KB raw — matched to the Firebase .validate length limits. GIFs animate live everywhere the photo / banner is shown (account card, profile dropdown, Revox member list, tournament-ranking row background)
- Running win-rate counter — every account has a public /winRates/{key} tally (wins / losses / ties). Bumped once per scored tournament match (gated by a wrApplied flag so re-scoring doesn't double-count); guests and single-elim by-name players are skipped (no stable account key). Rendered as "Win rate X% — Y W / Z L · T T" on your Profile card, the profile hover dropdown, and the Revox history popup. Hidden when there's no data yet
- Your profile banner doubles as your tournament-ranking row background — each ranked player's row is painted with their own banner (a medal-tinted scrim keeps the gold / silver / bronze podium identity)
- Discord-style profile card; admin-assigned tags show as colour-coded badges (Revox red, Developer black-and-blue, Revox Admin gold-bordered, Tester teal, Judge black-on-white)
- Auto medal tags: the current top 3 of the tournament ranking carry a "Gold Player" / "Silver Player" / "Bronze Player" badge on their profile — derived live from the ranking (not stored on the account), so it always reflects the current standing and shifts automatically as rankings change. The matching medal tag also unlocks the matching Gold / Silver / Bronze theme
- Tag chips render on a single horizontal line with an invisible scroller — same treatment in the profile page, the profile hover card, the Revox history popup and the Developer page rows
- Profile syncs to your account — same photo, name and bio on every device
- Anyone's profile opens as a card when you hover or click their username — in a tournament room, the final placement list, the tournament ranking, the Revox member list, or the Developer page

Developer
- Extra tab shown only to accounts tagged "Developer"
- Three sub-tabs: Users (the registered-user list + tag controls), Database (raw Firebase data browser), and Tags (reference list of every tag the app recognises — Admin / Role, Medal, Achievement — with the real badge styling and a short explanation of what each one unlocks)
- Users sub-tab: lists every registered user with a total count, searchable by username or email; each user's current tags show as badges
- Developers can add AND remove tags on any user (multiple tags per user)
- Hover or click a username in the list to open that account's profile card
- Database sub-tab: scrollable row of tabs across every readable top-level node (swissRooms, openTournaments, users, usernames, profiles, ranking, revoxRanking, winRates, achievements, judges, revoxAccounts, swissViewCodes, userDecks, userTournaments). Pick a node, see all entries as a sortable table — every field that exists across any row gets a column, heavy fields (photo / banner data URLs) summarized as "[N KB]", nested objects shown as "{count} firstKey, secondKey, …". The achievements table is keyed by UID with one column per achievement ID (dragonTamer / dragonSlayer / lonewolf / rushHour / kingOfJungle / sharknado / sorcererSupreme)
- Per-row actions: ✎ Edit fields (type-aware inputs — text / number / checkbox / textarea; photo / banner / smallBanner render as image preview + file picker, never raw base64), {} Edit raw JSON (pretty-printed textarea, parse on save, set to literal null to delete), 🗑 Delete (confirm prompt, then null-write)
- + Add entry at the top opens the JSON editor in new-entry mode — exposes a Key input + JSON value
- winRates table joins with /profiles to show the real cased username next to each W/L/T row
- Mobile-friendly: under 600 px the table flips to per-row cards (header hidden, every cell shows its column name as a label via data-col attr)
- Write permissions still enforced by Firebase rules — Developers can write users / profiles / ranking / revoxRanking / winRates / judges / revoxAccounts / openTournaments / swissViewCodes / userDecks / userTournaments, but swissRooms is still host-only and usernames is still owner-only. Failed writes surface a PERMISSION_DENIED alert

Other
- Per-tab URLs: /dashboard/, /calculator/, /library/, /deck/, /tournament/, /achievement/, /revox/, /battlepass/, /reel/, /history/, /settings/, /account/, /developer/
- "What's New" landing page at the site root
- Single-line horizontal tab bar (invisible scrollbar) — each tab shows its icon with a name label below; scroll position preserved across navigation. On desktop the bar spans the full viewport and stays centered regardless of which conditional tabs (Achievement / Revox / Developer) are visible. Every static tab icon is rendered as a CSS mask filled with the active theme's text color, so switching themes (Dark / Light / Tropical / Stormy / Mono / Love / Forest / Revox / Gold / Silver / Bronze / Dragon Tamer / Dragon Slayer / Lone Wolf / Rush Hour / King of The Jungle / Sharknado / Sorcerer Supreme / Paleonerd / King of All Types) re-colors every icon at once with no per-theme overrides. The Profile tab is the only exception — it shows the user's own avatar photo, not a mask
- X-Optimizer wordmark in the header is also a CSS-masked silhouette filled with currentColor, so the title logo adopts the active theme's text color on every page (the per-theme img-src swap is gone — one shared PNG works for every palette)
- Live Firebase sync across host / co-host / participant / viewer devices
- Multi-mode part images (Eclipse, Dual, Turbo, Operate, Scorpio Spear, Lightning L-Drago) display correctly everywhere — defaults to mode 0 when no mode is recorded
- Broken-image fallback hides only the image (rank chip + name stay), so Best Parts 1st / 2nd / 3rd rows never shift out of alignment
- Themed end-to-end: dashboard, scoreboard (sb-btn / round / hint / close / divider), tournament registering view (heading / format pills / + Register myself / row names), group + match cards (sub-tabs / round titles / match rows / seed pills / score cells), Bey Check popup (player tabs / slot cards / part tiles / labels), Rounds + Groups picker popups, Open Tournaments list, Revox input + member row action buttons (+ / delete), Account / Profile card (avatar ring, username, email, hint, bio), Developer pane (search field, user rows, names, count), deck-slot pencil edit button, empty-profile avatar placeholder (the silhouette sits on the themed card bg instead of a hard-coded dark slab), What's New page, charts, Battle Pass widgets
`;

  const btn = document.getElementById("settings-show-features");
  const popup = document.getElementById("features-popup");
  if (!btn || !popup) return;

  const listEl = popup.querySelector("#features-list");
  const copyBtn = popup.querySelector("#features-copy");
  const closeBtn = popup.querySelector("#features-close");
  const statusEl = popup.querySelector("#features-status");

  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) statusEl.classList.add(`is-${kind}`);
  };

  const open = () => {
    if (listEl) listEl.textContent = FEATURES_TEXT;
    setStatus("");
    popup.classList.remove("hidden");
  };
  const close = () => popup.classList.add("hidden");

  btn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  popup.addEventListener("click", (e) => { if (e.target === popup) close(); });


  copyBtn?.addEventListener("click", () => {
    const text = listEl ? listEl.textContent : FEATURES_TEXT;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          setStatus("Copied to clipboard.", "ok");
          setTimeout(() => setStatus(""), 1500);
        })
        .catch(() => setStatus("Couldn't copy. Select the text and copy manually.", "err"));
      return;
    }
    // Fallback for older browsers / non-HTTPS contexts.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      setStatus(ok ? "Copied to clipboard." : "Couldn't copy.", ok ? "ok" : "err");
      if (ok) setTimeout(() => setStatus(""), 1500);
    } catch (e) {
      setStatus("Couldn't copy. Select the text and copy manually.", "err");
    }
  });
})();

// ===== Service worker registration =====
// Registers /sw.js once per page load. The SW is minimal — it exists so
// that match-start notifications can be dispatched via
// registration.showNotification(), which mobile Chromium requires
// (it rejects `new Notification(...)` from a regular page). The SW
// itself doesn't intercept fetch or precache anything; updating just
// means bumping its SW_VERSION constant.
if ("serviceWorker" in navigator) {
  // Defer until after load so it doesn't fight the initial render.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(err => {
      console.info("Service worker registration failed:", err && err.message);
    });
  });
}

// ===== Settings → Match Alerts toggle =====
// Surfaces the Notification permission state and lets the user enable /
// disable system match-start notifications. Stored permission is browser-
// scoped; the enable/disable preference is per-device via localStorage,
// so a user with permission already granted can still mute alerts here.
// Reads:
//   - Notification.permission       — browser-managed (granted/denied/default)
//   - localStorage.matchAlertsOff   — "1" = muted even when permission granted
// The tournament-side fire path checks BOTH before showing a system notif.
(function initMatchAlertsSetting() {
  const btn = document.getElementById("match-alert-btn");
  const status = document.getElementById("match-alert-status");
  if (!btn || !status) return; // not the settings page

  const MUTE_KEY = "matchAlertsOff";
  const supported = typeof Notification === "function";

  function isMuted() {
    try { return localStorage.getItem(MUTE_KEY) === "1"; } catch (e) { return false; }
  }
  function setMuted(v) {
    try {
      if (v) localStorage.setItem(MUTE_KEY, "1");
      else localStorage.removeItem(MUTE_KEY);
    } catch (e) {}
  }

  function paint() {
    if (!supported) {
      status.textContent = "Not supported by this browser.";
      btn.textContent = "Unavailable";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    const perm = Notification.permission;
    if (perm === "denied") {
      status.textContent = "Blocked by the browser — enable Notifications for this site in your browser settings.";
      btn.textContent = "Blocked";
      btn.disabled = true;
      return;
    }
    if (perm === "default") {
      status.textContent = "Off — system notifications haven't been allowed yet.";
      btn.textContent = "Turn on";
      return;
    }
    // granted
    if (isMuted()) {
      status.textContent = "Muted on this device. Permission is granted, but alerts are off.";
      btn.textContent = "Turn on";
    } else {
      status.textContent = "On — you'll get a system notification when a match goes LIVE in any room you've joined.";
      btn.textContent = "Turn off";
    }
  }

  btn.addEventListener("click", () => {
    if (!supported) return;
    const perm = Notification.permission;
    if (perm === "denied") return; // can't change from here
    if (perm === "default") {
      try {
        const result = Notification.requestPermission();
        const handle = (p) => { if (p === "granted") setMuted(false); paint(); };
        if (result && typeof result.then === "function") result.then(handle);
        else if (typeof result === "string") handle(result);
      } catch (e) { paint(); }
      return;
    }
    // granted — toggle the per-device mute.
    setMuted(!isMuted());
    paint();
  });

  paint();
})();

  // ===== Account page (sign in/out + profile: username & photo) =====
  // The Account tab is its own page (/account/); this wires it. settings.js
  // loads on every page, so on non-account pages the elements are absent and
  // this whole block no-ops.
  (function initAccountPage() {
    const signedOut = document.getElementById("account-signedout");
    const signedIn = document.getElementById("account-signedin");
    if (!signedOut && !signedIn) return;
    const signInBtn = document.getElementById("account-signin-btn");
    const signOutBtn = document.getElementById("account-signout-btn");
    const avatar = document.getElementById("account-profile-avatar");
    const nameInput = document.getElementById("account-profile-username");
    const bioInput = document.getElementById("account-bio");
    const emailEl = document.getElementById("account-email");
    const tagsEl = document.getElementById("account-tags");
    const winRateEl = document.getElementById("account-win-rate");
    const saveBtn = document.getElementById("account-save-btn");
    const fileInput = document.getElementById("account-profile-file");
    const banner = document.getElementById("account-banner");
    const bannerFile = document.getElementById("account-banner-file");
    const statusEl = document.getElementById("account-status");

    // Neutral person-silhouette placeholder shown until a photo is set,
    // and a plain dark strip shown until a banner is set.
    const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%2321262d'/%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
    const BANNER_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 110'%3E%3Crect width='400' height='110' fill='%2321262d'/%3E%3C/svg%3E";

    let pendingPhoto = "";
    let pendingBanner = "";
    // CSS object-position strings — what part of the uploaded image stays
    // in the visible crop. "" = use the default (centered).
    let pendingPhotoPos = "";
    let pendingBannerPos = "";

    const setStatus = (msg, kind) => {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.classList.remove("is-ok", "is-err", "is-pending");
      if (kind) statusEl.classList.add(`is-${kind}`);
    };

    // Render the tag badges for `profile`, led by the live medal tag
    // (Gold/Silver/Bronze Player) when the account currently sits in the
    // ranking's top 3. Split out of fill() so it can re-run on its own
    // when the medal cache loads — without touching pending photo edits.
    const renderAccountTags = (profile) => {
      if (!tagsEl) return;
      const tags = ((profile && profile.tags) || []).slice();
      const medal = (typeof window.medalTagForName === "function")
        ? window.medalTagForName((profile && profile.username) || "")
        : "";
      const allTags = medal ? [medal].concat(tags) : tags;
      tagsEl.textContent = "";
      allTags.forEach(t => {
        const s = document.createElement("span");
        // Colour the badge by tag family: Revox tags use the Revox theme
        // colour, the Developer tag uses a black-and-blue badge, the medal
        // tags use gold / silver / bronze.
        const lower = String(t || "").toLowerCase();
        let variant = "";
        if (lower.indexOf("revox") >= 0) {
          variant = " account-tag-revox";
          if (lower === "revox admin") variant += " account-tag-revox-admin";
        } else if (lower === "developer") {
          variant = " account-tag-developer";
        } else if (lower === "tester") {
          variant = " account-tag-tester";
        } else if (lower === "judge") {
          variant = " account-tag-judge";
        } else if (lower === "gold player") {
          variant = " account-tag-gold";
        } else if (lower === "silver player") {
          variant = " account-tag-silver";
        } else if (lower === "bronze player") {
          variant = " account-tag-bronze";
        }
        s.className = "account-tag" + variant;
        s.textContent = t;
        tagsEl.appendChild(s);
      });
      tagsEl.classList.toggle("hidden", !allTags.length);
    };

    // The last profile shown — lets the medal-cache event re-render just
    // the tag row (see the rankingmedalschange listener below).
    let lastFilledProfile = null;

    const fill = (profile) => {
      lastFilledProfile = profile || {};
      pendingPhoto = (profile && profile.photo) || "";
      pendingBanner = (profile && profile.banner) || "";
      pendingPhotoPos = (profile && profile.photoPos) || "";
      pendingBannerPos = (profile && profile.bannerPos) || "";
      if (nameInput) nameInput.value = (profile && profile.username) || "";
      if (bioInput) bioInput.value = (profile && profile.bio) || "";
      renderAccountTags(lastFilledProfile);
      if (avatar) {
        avatar.src = pendingPhoto || PLACEHOLDER;
        avatar.style.objectPosition = pendingPhotoPos || "50% 50%";
      }
      if (banner) {
        banner.src = pendingBanner || BANNER_PLACEHOLDER;
        banner.style.objectPosition = pendingBannerPos || "50% 50%";
      }
      loadAccountWinRate(profile && profile.username);
    };

    // Public win-rate counter, fetched from /winRates/{usernameKey}. Hidden
    // entirely when there's no record (new user, never scored). Mirrors the
    // display logic in showProfileByUsername so the same person sees the
    // same numbers here and on their popup card.
    const loadAccountWinRate = (username) => {
      if (!winRateEl) return;
      winRateEl.textContent = "";
      winRateEl.classList.add("hidden");
      if (!username) return;
      const fb = (typeof firebase !== "undefined" && firebase.database) ? firebase.database() : null;
      if (!fb) return;
      const key = String(username)
        .trim()
        .toLowerCase()
        .replace(/[.#$/\[\]]/g, "_");
      if (!key) return;
      fb.ref("winRates/" + key).once("value").then(snap => {
        const v = snap.val();
        const wins = (v && v.wins) || 0;
        const losses = (v && v.losses) || 0;
        const ties = (v && v.ties) || 0;
        const total = wins + losses + ties;
        if (total === 0) return; // no data → leave hidden
        const pct = Math.round((wins / total) * 100);
        const tieBit = ties > 0 ? ` · ${ties}T` : "";
        winRateEl.textContent = `Win rate ${pct}% — ${wins}W / ${losses}L${tieBit}`;
        winRateEl.classList.remove("hidden");
      }).catch(() => { /* read failed → leave hidden */ });
    };

    // The medal cache loads / changes asynchronously — refresh only the
    // tag row so a freshly-known medal appears without wiping a photo the
    // user may have picked but not yet saved.
    window.addEventListener("rankingmedalschange", () => {
      if (lastFilledProfile) renderAccountTags(lastFilledProfile);
    });

    // Toggle the signed-in / signed-out panes and load the profile.
    const render = (user) => {
      try { console.info("[account] render called with user:", !!user, user && user.email); } catch (e) {}
      if (user) {
        signedOut?.classList.add("hidden");
        signedIn?.classList.remove("hidden");
        if (emailEl) emailEl.textContent = user.email || "";
        setStatus("");
        if (typeof window.loadUserProfile === "function") {
          window.loadUserProfile().then(p => fill(p || {}));
        } else {
          fill({});
        }
      } else {
        signedIn?.classList.add("hidden");
        signedOut?.classList.remove("hidden");
      }
    };

    // Resolve the current user from whichever source is ready. onAuthChange
    // can miss its first callback on bfcache restore or when auth.js hasn't
    // attached its listener yet; falling through to firebase.auth() directly
    // covers that gap so the signed-in view doesn't get stuck behind the
    // sign-in pane on a returning session.
    const resolveCurrentUser = () => {
      try {
        if (typeof window.getCurrentUser === "function") {
          const u = window.getCurrentUser();
          if (u) return u;
        }
        if (typeof firebase !== "undefined" && firebase.auth) {
          return firebase.auth().currentUser || null;
        }
      } catch (e) {}
      return null;
    };

    if (typeof window.onAuthChange === "function") {
      try { console.info("[account] registering onAuthChange"); } catch (e) {}
      window.onAuthChange(render);
    }
    if (typeof firebase !== "undefined" && firebase.auth) {
      try {
        firebase.auth().onAuthStateChanged(render);
        console.info("[account] registered firebase.auth().onAuthStateChanged");
      } catch (e) {}
    }
    // Synchronous render with whatever auth state is already known. Then
    // poll for up to ~4 seconds in case the auth listeners never fire (we
    // have seen this on disk-cache restores). Once we see a user, render
    // and stop polling.
    const initial = resolveCurrentUser();
    try { console.info("[account] initial resolveCurrentUser:", !!initial); } catch (e) {}
    render(initial);
    if (!initial) {
      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        const u = resolveCurrentUser();
        if (u) {
          try { console.info("[account] poll resolved user after", tries, "tries"); } catch (e) {}
          clearInterval(poll);
          render(u);
        } else if (tries >= 20) {
          clearInterval(poll);
        }
      }, 200);
    }

    signInBtn?.addEventListener("click", () => {
      if (typeof window.showSignInPopup === "function") window.showSignInPopup({}).catch(() => {});
    });
    signOutBtn?.addEventListener("click", () => {
      if (typeof window.signOutCurrentUser !== "function") return;
      if (!confirm("Sign out of this account?")) return;
      window.signOutCurrentUser().catch(e => alert("Sign out failed: " + (e?.message || e)));
    });

    // Downscale a picked image to a small JPEG data-URL so the profile
    // record stays tiny enough to live in the Realtime Database.
    const downscale = (file, maxSize) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That file isn't a readable image."));
        img.onload = () => {
          // iOS Safari can fire `load` before the bitmap is fully decoded,
          // so drawImage() ends up painting blank. Wait for decode() first.
          const finish = () => {
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          };
          if (img.decode) img.decode().then(finish, finish);
          else finish();
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

    // Image crop editor — opens after a fresh upload so the user can pan
    // AND zoom to pick the visible crop. The image lives in an absolutely
    // positioned <img> inside an overflow:hidden frame; drag updates its
    // top/left, the slider / wheel / pinch updates its scale. zoom = 1 is
    // "cover" — the smaller dimension exactly fills the frame; max zoom
    // 4 is a tight crop. On Apply the visible region is drawn to a canvas
    // and the cropped data URL is the new image — so the display path
    // stays a plain object-fit:cover <img> with no extra transforms.
    const openImageCropEditor = (opts) => {
      const { src, kind, onSave } = opts;
      document.getElementById("image-pos-editor")?.remove();
      const isPhoto = kind === "photo";
      // Smaller editor frames + non-scrolling card so the whole popup fits
      // on a phone-portrait viewport without the popup-card's own scroll
      // kicking in. Banner keeps its 3:1 display aspect at a more modest
      // 280×93; photo at 180×180.
      const frameW = isPhoto ? 180 : 280;
      const frameH = isPhoto ? 180 : 93;
      // Output dims of the baked crop. Photo stays square at 256; banner
      // matches the editor frame's 3:1 aspect at 1024-wide.
      const outputW = isPhoto ? 256 : 1024;
      const outputH = isPhoto ? 256 : Math.round(outputW * frameH / frameW);
      const frameCss = isPhoto
        ? `width:${frameW}px;height:${frameH}px;border-radius:50%;`
        : `width:${frameW}px;height:${frameH}px;border-radius:8px;`;

      const overlay = document.createElement("div");
      overlay.id = "image-pos-editor";
      overlay.className = "popup-overlay";
      overlay.innerHTML = `
        <div class="popup-card" style="overflow:hidden;max-height:none;">
          <h2 class="popup-title">${isPhoto ? "Adjust photo" : "Adjust banner"}</h2>
          <p class="popup-text">Drag to pan, scroll / pinch / use the slider to zoom.</p>
          <div class="image-pos-frame" style="${frameCss}margin:10px auto;overflow:hidden;background:#0d1117;position:relative;cursor:grab;touch-action:none;user-select:none;">
            <img class="image-pos-img" src="${src}" alt="" draggable="false" style="position:absolute;left:0;top:0;pointer-events:none;max-width:none;max-height:none;">
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin:8px 4px 0;">
            <span style="font-size:0.78rem;opacity:.7;">Zoom</span>
            <input type="range" class="image-pos-zoom" min="100" max="400" value="100" step="1" style="flex:1;">
          </div>
          <div class="popup-actions">
            <button type="button" class="btn" data-act="save">Apply</button>
            <button type="button" class="btn popup-cancel" data-act="cancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const frame = overlay.querySelector(".image-pos-frame");
      const imgEl = overlay.querySelector(".image-pos-img");
      const zoomSlider = overlay.querySelector(".image-pos-zoom");

      // Source image loaded into a hidden <img> too, so we can read
      // naturalWidth/Height before painting (avoids a layout-jump).
      const srcImg = new Image();
      // Same-origin data URLs don't need crossOrigin, but it's harmless.
      srcImg.src = src;

      // Geometry — zoom is multiplicative on baseScale (cover). offsetX/Y
      // is the image element's left/top inside the frame, clamped so the
      // image always covers the frame (no empty space).
      let baseScale = 1;
      let zoom = 1;
      let offsetX = 0, offsetY = 0;

      const clamp = () => {
        const w = srcImg.naturalWidth * baseScale * zoom;
        const h = srcImg.naturalHeight * baseScale * zoom;
        if (w <= frameW) offsetX = (frameW - w) / 2;
        else offsetX = Math.min(0, Math.max(frameW - w, offsetX));
        if (h <= frameH) offsetY = (frameH - h) / 2;
        else offsetY = Math.min(0, Math.max(frameH - h, offsetY));
      };

      const apply = () => {
        clamp();
        const w = srcImg.naturalWidth * baseScale * zoom;
        const h = srcImg.naturalHeight * baseScale * zoom;
        imgEl.style.width = w + "px";
        imgEl.style.height = h + "px";
        imgEl.style.left = offsetX + "px";
        imgEl.style.top = offsetY + "px";
      };

      const initOnLoad = () => {
        baseScale = Math.max(frameW / srcImg.naturalWidth, frameH / srcImg.naturalHeight);
        zoom = 1;
        const w = srcImg.naturalWidth * baseScale * zoom;
        const h = srcImg.naturalHeight * baseScale * zoom;
        offsetX = (frameW - w) / 2;
        offsetY = (frameH - h) / 2;
        apply();
      };
      if (srcImg.complete && srcImg.naturalWidth) initOnLoad();
      else srcImg.addEventListener("load", initOnLoad, { once: true });

      // ---- Pan (single-finger / mouse drag) ----
      let dragging = false, startPX = 0, startPY = 0, startOX = 0, startOY = 0;
      const onDown = (e) => {
        if (pointers.size >= 2) return; // pinch path owns this gesture
        dragging = true;
        startPX = e.clientX; startPY = e.clientY;
        startOX = offsetX; startOY = offsetY;
        frame.style.cursor = "grabbing";
        frame.setPointerCapture?.(e.pointerId);
      };
      const onMove = (e) => {
        if (!dragging || pointers.size >= 2) return;
        offsetX = startOX + (e.clientX - startPX);
        offsetY = startOY + (e.clientY - startPY);
        apply();
      };
      const onUp = () => { dragging = false; frame.style.cursor = "grab"; };

      // ---- Pinch zoom (two-finger) ----
      const pointers = new Map();
      let pinchStartDist = 0;
      let pinchStartZoom = 1;
      const pinchDist = () => {
        const pts = Array.from(pointers.values());
        if (pts.length < 2) return 0;
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        return Math.hypot(dx, dy);
      };

      frame.addEventListener("pointerdown", (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) onDown(e);
        else if (pointers.size === 2) {
          dragging = false;
          pinchStartDist = pinchDist();
          pinchStartZoom = zoom;
        }
      });
      frame.addEventListener("pointermove", (e) => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2 && pinchStartDist > 0) {
          const ratio = pinchDist() / pinchStartDist;
          zoom = Math.max(1, Math.min(4, pinchStartZoom * ratio));
          zoomSlider.value = Math.round(zoom * 100);
          apply();
        } else {
          onMove(e);
        }
      });
      const releasePointer = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchStartDist = 0;
        if (pointers.size === 0) onUp();
      };
      frame.addEventListener("pointerup", releasePointer);
      frame.addEventListener("pointercancel", releasePointer);
      frame.addEventListener("pointerleave", releasePointer);

      // ---- Wheel zoom (centered on cursor) ----
      frame.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = frame.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.002); // gentle exponential
        const oldZoom = zoom;
        zoom = Math.max(1, Math.min(4, zoom * factor));
        // Keep the cursor's source-image point fixed under the cursor.
        const imgPxX = (cx - offsetX) / oldZoom;
        const imgPxY = (cy - offsetY) / oldZoom;
        offsetX = cx - imgPxX * zoom;
        offsetY = cy - imgPxY * zoom;
        zoomSlider.value = Math.round(zoom * 100);
        apply();
      }, { passive: false });

      // ---- Slider zoom (centered on frame middle) ----
      zoomSlider.addEventListener("input", () => {
        const newZoom = Math.max(1, Math.min(4, Number(zoomSlider.value) / 100));
        const cx = frameW / 2, cy = frameH / 2;
        const imgPxX = (cx - offsetX) / zoom;
        const imgPxY = (cy - offsetY) / zoom;
        zoom = newZoom;
        offsetX = cx - imgPxX * zoom;
        offsetY = cy - imgPxY * zoom;
        apply();
      });

      const close = () => overlay.remove();
      overlay.querySelector('[data-act="cancel"]').onclick = close;
      overlay.querySelector('[data-act="save"]').onclick = () => {
        if (!srcImg.naturalWidth) { close(); return; }
        clamp();
        // Source rect in image-pixel coords for the visible frame region.
        // Each frame pixel maps to (1 / (baseScale * zoom)) image pixels.
        const ratio = 1 / (baseScale * zoom);
        const sx = (0 - offsetX) * ratio;
        const sy = (0 - offsetY) * ratio;
        const sw = frameW * ratio;
        const sh = frameH * ratio;
        const canvas = document.createElement("canvas");
        canvas.width = outputW;
        canvas.height = outputH;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, outputW, outputH);
        const baked = canvas.toDataURL("image/jpeg", 0.85);
        close();
        onSave?.(baked);
      };

      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); document.removeEventListener("keydown", onKey); }
      };
      document.addEventListener("keydown", onKey);
    };

    // Tap the avatar / banner image itself to change it.
    avatar?.addEventListener("click", () => fileInput?.click());

    // GIFs bypass the canvas pipeline — drawing one to a canvas always
    // flattens it to a single still frame, killing the animation. We
    // store the original bytes as a data URL and skip the crop editor
    // (re-encoding an animated GIF needs a heavy library; not worth it
    // for avatars). Size caps match the Firebase .validate caps for
    // the photo / banner fields — bump both ends together if changing.
    const PHOTO_GIF_MAX_CHARS = 500000;   // ~375 KB raw
    const BANNER_GIF_MAX_CHARS = 1000000; // ~750 KB raw
    const isGifFile = (file) => !!file && (file.type === "image/gif" || /\.gif$/i.test(file.name));
    const readDataUrl = (file) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error("Couldn't read that file."));
      r.onload = () => resolve(r.result);
      r.readAsDataURL(file);
    });
    // Friendly "your file is X KB, max is Y KB" message instead of a
    // bare "too large" hint, so the user knows exactly how much to trim.
    const formatGifSizeError = (dataUrlLen, capChars, label) => {
      const haveKB = Math.round(dataUrlLen * 0.75 / 1024); // base64 ≈ 1.33× raw
      const capKB = Math.round(capChars * 0.75 / 1024);
      return `${label} is ~${haveKB} KB — max is ~${capKB} KB. Try a smaller / more optimised GIF (fewer frames, smaller dimensions, or higher compression).`;
    };

    // GIFs skip the canvas-baked crop editor (the bake would freeze the
    // animation). Show a simple preview popup so the user has the same
    // visual "is this what I picked?" confirmation step the JPEG path
    // gets via the crop editor. The GIF is sized to the same frame
    // shape used by the crop editor (circle for photo, 3:1 for banner)
    // and plays live inside the frame.
    const openGifPreviewPopup = (opts) => {
      const { src, kind, sizeKB, onConfirm } = opts;
      document.getElementById("image-pos-editor")?.remove();
      const isPhoto = kind === "photo";
      const frameW = isPhoto ? 180 : 280;
      const frameH = isPhoto ? 180 : 93;
      const frameCss = isPhoto
        ? `width:${frameW}px;height:${frameH}px;border-radius:50%;`
        : `width:${frameW}px;height:${frameH}px;border-radius:8px;`;
      const overlay = document.createElement("div");
      overlay.id = "image-pos-editor";
      overlay.className = "popup-overlay";
      overlay.innerHTML = `
        <div class="popup-card" style="overflow:hidden;max-height:none;">
          <h2 class="popup-title">${isPhoto ? "Animated photo" : "Animated banner"}</h2>
          <p class="popup-text">GIFs skip the crop / zoom editor — animation would be lost. The full image is saved as-is.</p>
          <div class="image-pos-frame" style="${frameCss}margin:10px auto;overflow:hidden;background:#0d1117;position:relative;">
            <img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:50% 50%;pointer-events:none;">
          </div>
          <p class="popup-text" style="font-size:0.78rem; margin-top:6px; text-align:center; opacity:.75;">~${sizeKB} KB</p>
          <div class="popup-actions">
            <button type="button" class="btn" data-act="use">Use this</button>
            <button type="button" class="btn popup-cancel" data-act="cancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('[data-act="cancel"]').onclick = close;
      overlay.querySelector('[data-act="use"]').onclick = () => { close(); onConfirm?.(); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); document.removeEventListener("keydown", onKey); }
      };
      document.addEventListener("keydown", onKey);
    };

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // let the same file be re-picked later
      if (!file) return;
      if (isGifFile(file)) {
        setStatus("Processing GIF…", "pending");
        console.info("[profile] photo GIF picked:", file.name, file.size, "bytes,", file.type);
        readDataUrl(file).then(dataUrl => {
          if (dataUrl.length > PHOTO_GIF_MAX_CHARS) {
            throw new Error(formatGifSizeError(dataUrl.length, PHOTO_GIF_MAX_CHARS, "That GIF"));
          }
          openGifPreviewPopup({
            src: dataUrl,
            kind: "photo",
            sizeKB: Math.round(dataUrl.length * 0.75 / 1024),
            onConfirm: () => {
              pendingPhoto = dataUrl;
              pendingPhotoPos = "50% 50%";
              if (avatar) {
                avatar.src = dataUrl;
                avatar.style.objectPosition = "50% 50%";
              }
              setStatus("GIF ready — tap Save profile to keep it.", "ok");
            }
          });
          setStatus("", "");
        }).catch(e => {
          console.warn("[profile] photo GIF failed:", e);
          // The account-status text strip is below the fold on some
          // viewports — surface GIF failures as a real alert so they're
          // unmissable. Most common cause is the file being too big.
          alert(e.message || "Couldn't process that GIF.");
          setStatus(e.message || "Couldn't process that GIF.", "err");
        });
        return;
      }
      setStatus("Processing photo…", "pending");
      // Downscale generously — the editor crops INTO this image, so giving
      // it more pixels means the final baked crop stays sharp at the
      // chosen zoom level.
      downscale(file, 1024)
        .then(dataUrl => {
          openImageCropEditor({
            src: dataUrl,
            kind: "photo",
            onSave: (bakedUrl) => {
              // The crop / zoom is baked into bakedUrl — display stays a
              // plain object-fit:cover with centered position.
              pendingPhoto = bakedUrl;
              pendingPhotoPos = "50% 50%";
              if (avatar) {
                avatar.src = bakedUrl;
                avatar.style.objectPosition = "50% 50%";
              }
              setStatus("Photo ready — tap Save profile to keep it.", "ok");
            }
          });
          setStatus("", "");
        })
        .catch(e => setStatus(e.message || "Couldn't process that image.", "err"));
    });

    banner?.addEventListener("click", () => bannerFile?.click());

    bannerFile?.addEventListener("change", () => {
      const file = bannerFile.files && bannerFile.files[0];
      bannerFile.value = "";
      if (!file) return;
      if (isGifFile(file)) {
        setStatus("Processing GIF…", "pending");
        console.info("[profile] banner GIF picked:", file.name, file.size, "bytes,", file.type);
        readDataUrl(file).then(dataUrl => {
          if (dataUrl.length > BANNER_GIF_MAX_CHARS) {
            throw new Error(formatGifSizeError(dataUrl.length, BANNER_GIF_MAX_CHARS, "That banner GIF"));
          }
          openGifPreviewPopup({
            src: dataUrl,
            kind: "banner",
            sizeKB: Math.round(dataUrl.length * 0.75 / 1024),
            onConfirm: () => {
              pendingBanner = dataUrl;
              pendingBannerPos = "50% 50%";
              if (banner) {
                banner.src = dataUrl;
                banner.style.objectPosition = "50% 50%";
              }
              setStatus("GIF ready — tap Save profile to keep it.", "ok");
            }
          });
          setStatus("", "");
        }).catch(e => {
          console.warn("[profile] banner GIF failed:", e);
          alert(e.message || "Couldn't process that GIF.");
          setStatus(e.message || "Couldn't process that GIF.", "err");
        });
        return;
      }
      setStatus("Processing banner…", "pending");
      downscale(file, 2048)
        .then(dataUrl => {
          openImageCropEditor({
            src: dataUrl,
            kind: "banner",
            onSave: (bakedUrl) => {
              pendingBanner = bakedUrl;
              pendingBannerPos = "50% 50%";
              if (banner) {
                banner.src = bakedUrl;
                banner.style.objectPosition = "50% 50%";
              }
              setStatus("Banner ready — tap Save profile to keep it.", "ok");
            }
          });
          setStatus("", "");
        })
        .catch(e => setStatus(e.message || "Couldn't process that image.", "err"));
    });

    saveBtn?.addEventListener("click", () => {
      if (typeof window.saveUserProfile !== "function") return;
      const username = (nameInput?.value || "").trim();
      if (!username) { setStatus("Enter a username.", "err"); nameInput?.focus(); return; }
      setStatus("Saving…", "pending");
      saveBtn.disabled = true;
      window.saveUserProfile({
        username,
        photo: pendingPhoto,
        banner: pendingBanner,
        photoPos: pendingPhotoPos,
        bannerPos: pendingBannerPos,
        bio: (bioInput?.value || "").trim()
      })
        .then(() => setStatus("Profile saved ✓", "ok"))
        .catch(e => setStatus(e.message || "Couldn't save your profile.", "err"))
        .finally(() => { saveBtn.disabled = false; });
    });
  })();
