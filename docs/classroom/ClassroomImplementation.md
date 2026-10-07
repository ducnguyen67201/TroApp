# Classroom implementation and pilot setup

Updated October 3, 2026. Initial implementation of the
[classroom context design](ClassroomContextEngineeringSpec.md). This is a local
development/pilot foundation, not approval for a hosted classroom release.

## Delivered behavior

### Class pages and invitations

Selecting a class opens its own page within the desktop, with the illustration
retained on the right. Teacher Overview contains sections and session controls;
Materials contains preparation and review; Settings contains student enrollment,
invitation codes and deletion. The installed app uses hash routes
`#/classroom/<classId>`, `/materials` and `/settings`, preserving Back/Forward
without loading another Electron document. A URL is not authorization: the page
must match a class in the signed-in account's backend home snapshot.

In Settings, enter the email of a student who has already signed in, then choose
**Add student**. The existing `enroll` command adds their account immediately; their
next classroom refresh shows the class. It does not join a live session, send email,
or create an account. Unknown emails show a sign-in-first message. Shared codes
remain available for students without an existing account; they sign in and enter
the code themselves. There is no pending email invitation or auto-enrollment upon
first sign-in in this implementation.

Class cards and the detail panel display **Live now / Đang diễn ra** in a green
pill when the home snapshot contains a live session. Otherwise they show
**Waiting to start / Chờ bắt đầu**. The indicator describes session availability,
not teacher presence or student participation; students still explicitly join.
It updates with the existing classroom refresh flow, with no new backend fields.

### Live teaching controls

During a live session, Overview uses the full content width for lesson rows and a
sticky teaching bar. The large illustration, preparation panel and setup note are
hidden until the session ends or the teacher opens another tab. The active section
always exposes Explanation, Practice, Submission and Review. Clicking another row
reveals the same buttons without publishing a change; choosing a stage sends one
existing `update-session` command with that section, stage and confirmed pacing.
**Next section** advances to the following section in Explanation, preserving pacing.
It is disabled on the final section. These are one-click current-stage changes and
two-click jumps; there is no extra Apply step.

Student pacing and End session live in the teaching bar's options menu. Pacing
changes apply immediately to the current section and stage. Session updates keep
the existing context version and authorization checks. Highlights always follow
the returned home snapshot, not the requested choice. A spinner blocks additional
changes while saving. Failed changes preserve the confirmed stage and expose Retry;
retry uses the latest session version. No backend or wire-contract changes are needed.

### Deleting a class or material

In the teacher's class detail panel, **Delete class** opens a confirmation naming
the selected class. Only its owning teacher can confirm. A live session must be
ended first; the server checks this again in the same serializable transaction as
deletion. The class disappears from teacher/student home lists, invitation codes
are revoked, and classroom/material access is refused. Submitted work, enrollment,
session history and original files remain stored rather than cascading deletion.
There is no restore screen in this pilot.

The additive `20261004015000_classroom_deletion` migration adds a nullable
`ClassroomGroup.deletedAt` timestamp. Existing classes remain active. Restart the
normal development command to apply migrations; hosted installations follow the
reviewed deployment migration workflow. No database reset is required.

Each material row has a labeled **Delete** action and confirmation. Removal uses
the existing versioned `remove` command and returns the collection to preparation.
Unused original files are deleted to reclaim storage; files referenced by any
approved publication are retained for that immutable revision. Prepare and approve
again to update materials available to students. Preparation-in-progress and
unsaved review edits continue to block collection changes.

`ClassroomService` owns authorization and the live-session rule. `ClassroomStore`
exposes deletion ports; the Prisma adapter owns filtering, the tombstone and
published-file reference checks. Desktop uses its existing validated command
bridge. `ClassDeletion.tsx` and `MaterialFiles.tsx` own confirmation presentation.

### Teaching and learning

Teachers create classes by name and prepare uploaded materials through the
[materials-first workflow](MaterialPreparationEngineering.md), publishing a reviewed immutable revision. They
invite students by shared or email-bound codes, and start/end a meeting. Sessions begin in
explanation and support explanation, practice, submission and review phases.
Teacher-paced sessions expose only the current activity; self-paced sessions let
students select activities independently. No minimum student count is required.

Students explicitly join. Enrollment, joining, connection presence, reported progress
and submission are separate facts. Late joiners load the current section. Rejoining
restores the same participation and per-activity working resource/progress; a new
device takes control and the old device's commands fail authorization. Esc cancels
guidance without leaving the class. Teacher changes retain previous activity work. Rejoining also restores the latest durable
submission receipt for the selected activity.

Each class-bound Show me request loads fresh authorized context before entering the
existing teaching worker. Typed and voice requests use the same chat controller.
The packet contains one activity, material roles, prerequisites, teacher criteria,
phase/pacing, working project and student progress. A short follow-up receives this
durable context; it does not restore stale screenshots or drawings. The existing
presenter still pairs spatial instructions with native cues. Classroom Do it for me
requests are rejected; general chat retains its existing modes.

Worker tools read the registered work, register an evidenced URL, report model
observations and prepare a submission. They cannot enroll students, change phases,
commit a submission or directly bypass the drawing presenter. Workspace lookup is
not a browser navigation receipt: the tutor uses its existing observation/focus tools
and presents the recovery route. Universal tab enumeration/recovery is not promised.

The student reviews a prepared Scratch project link in the Classroom panel and
explicitly confirms hand-in. Preparation has a ten-minute expiry, activity/context
and progress versions, and is separate from submission. Retries reuse one idempotency
key; concurrent commits produce one receipt. Changed working references or progress
invalidate old preparations. A hand-in receipt confirms that Tro stored the link,
not that the project is accessible, immutable, correct or graded. Teachers can read
their class roster, reported observations and hand-in links.

## Ownership

| File or folder                                                            | Responsibility                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/Classroom.ts`                                              | Canonical validated commands, replies, bounded curriculum/context, fixed values and restricted worker tool protocol |
| `src/server/features/classroom/domain/ClassroomRules.ts`                  | Framework-free activity, pacing and resource rules; safe business errors                                            |
| `src/server/features/classroom/application/ClassroomService.ts`           | Authorization, course/class/session workflows, scoped context and hand-in coordination                              |
| `src/server/features/classroom/application/ClassroomStore.ts`             | Typed persistence/transaction port                                                                                  |
| `src/server/persistence/PrismaClassroomStore.ts`                          | Prisma-only adapter; serializable transactions with bounded conflict retries                                        |
| `src/server/features/classroom/infrastructure/RegisterClassroomRoutes.ts` | Authenticated HTTP command and update-stream adapters; bounded safe diagnostics                                     |
| `src/desktop/main/classroom`                                              | Cookie-authenticated client, one participation binding, heartbeat and revision fences                               |
| `src/desktop/worker/teaching/ClassroomToolClient.ts`                      | Correlated cancellable private main/worker operations                                                               |
| `src/desktop/worker/teaching/ClassroomTeachingTools.ts`                   | Narrow agent-facing classroom tools                                                                                 |
| `src/desktop/renderer/classroom`                                          | Localized connection panel, course editor, teacher session controls and student activity/hand-in views              |

The first feature remains together under `classroom`; course and learning modules
can be extracted when they gain independent consumers. No empty feature packages,
extra agent harness, generic IPC, database access in Electron or event broker were
introduced. Course modules/lessons/activities are validated JSON inside an immutable
revision; classes, enrollment, sessions, participation, attempts, preparations and
submissions have relational records and foreign keys. The initial class assignment
is pinned for the life of that class; changing a published course means publishing
a new revision and assigning it to a new class in this pilot.

## Setup and walkthrough

1. Use the existing individual Google sign-in flow on each device. Students must
   sign in to accept an invitation. Email-bound codes work after that first sign-in.
2. Accounts default to the stored Student role. A backend operator grants Teacher
   once by verified email: `doppler run -- pnpm account:role teacher@example.com teacher`.
   Use `student` to revoke teacher access. No maintained ID list or public self-promotion
   endpoint is used. Open Classroom to refresh the role label; backend commands always
   read the current database role. Existing course/class owners retain Teacher through
   the migration. There is no administrator UI yet.
3. Apply the committed migration through the normal development startup or reviewed
   `pnpm db:deploy` workflow, then regenerate Prisma. No existing records are reset.
4. Open **Classroom** in the desktop sidebar. The role badge appears under Tro.
   Classroom is a page rather than a modal: teachers have **My classes** and
   **Prepare lessons** tabs; students have code entry, class cards and their current work. An authorized teacher can prepare a
   lesson with multiple sections, objectives, criteria, prerequisites and a material
   URL/role. This small editor creates one module and lesson; the HTTP contract
   supports richer module/lesson structure. File bytes are not uploaded.
5. Publish, create the class with that revision, then generate a shared invitation
   code or enter an email to restrict the code to that verified account. Share the
   code yourself; Tro does not send emails. Codes expire after seven days; the teacher
   can disable all existing codes for that class. Select the first section and pacing,
   then start the session. It begins in explanation.
6. On each student's device, open Classroom, enter the code to enroll, then join
   the live session. Enrollment works before a session starts; class cards show
   waiting for the teacher until a live meeting exists.
   Ask Tro for help through normal Show me chat or voice. Register their actual
   saved working project URL, rather than the demonstration or starter.
7. The teacher selects a section and phase. Teacher-paced students follow the new
   section; self-paced students can choose independently. The Classroom panel
   refreshes while open. Normal guidance continues to use the compact localized HUD.
8. Students can report that they finished, prepare a hand-in and confirm the displayed
   project link. Teacher **Student status** shows joined/connected state, reported
   criteria, student-declared completion, help summaries and submitted links separately.
9. End the meeting. Guidance stops on connected student devices; their projects and
   durable records are retained. Students can leave individually instead.

Only HTTPS resource references without embedded credentials are accepted. Scratch
hand-ins require `https://scratch.mit.edu/projects/<numeric-id>/` with no query,
fragment or alternate host. The backend does not fetch these links, so there is no
server-side URL execution. A URL alone does not prove ownership or readability;
student confirmation and teacher review remain necessary.

## Updates, resources and limitations

Invitation codes carry enrollment authority only, never account-role or teacher
permissions. Only their SHA-256 digests are stored; the raw code is disclosed on
creation and is not included in agent context or ordinary logs. Verified sign-in,
email binding when supplied, current teacher authority, expiry and revocation are
checked transactionally on acceptance. Repeated enrollment is idempotent. Code
attempts are limited per account on this API instance; hosted multi-instance abuse
controls remain a deployment requirement. Revoking a code prevents further use;
it does not remove existing enrollment (use Remove enrollment separately).

The backend exposes `/api/v1/classroom/command` with a strict command union and
`/api/v1/classroom/updates` with an authenticated SSE wakeup stream. Main alone attaches
the session cookie. Teacher phase/activity/end/revocation events wake connected
devices; the device reauthorizes and reads a fresh snapshot. A 20-second heartbeat
renews a 60-second lease and covers reconnects or missed events. In-process wakeups
are a single-API-instance optimization; multi-instance immediate delivery would need
a separately reviewed shared notification mechanism. Snapshot/version checks remain
authoritative. Stream failure pauses active class guidance until a fresh read succeeds.

Late worker output and tools are fenced by participation, attempt and context version.
Network failures retain the binding for retry but prevent tasks from silently falling
back to general chat. Closing/signing out releases local guidance and connection;
the backend presence expires if leave cannot be delivered. Classroom content is not
loaded into the model merely by joining. Presence and idle waiting use no inference
or continuous capture.

Progress reports are evidence-qualified claims, not automatic grades. The server
checks identities, canonical criterion IDs and versions, not the correctness of
visual interpretation. No automatic stuck label is inferred from inactivity. No new
continuous screen stream, screenshot persistence or hidden model reasoning logging
was added. Safe rejection diagnostics include operation, reason code and correlation
ID, without raw project URLs, material contents or credentials.

Deferred capabilities: teacher-to-device resource dispatch; file upload/private object
storage; automatic material parsing; CMS integration; automatic submission/grading;
shared-device student login; richer teacher feedback and center roles; draft editing
and course revision adoption for an existing class. These require separate bounded
adapters and release decisions. Hosted model quotas, artifact retention/deletion,
multi-device hardware and classroom privacy checks remain release prerequisites.

## Verification

Focused tests cover authorization, two independent student workspaces, teacher and
self pacing, stale writes, progress idempotency, device takeover, hand-in preparation
and duplicate receipts, session ending/revocation, late activity reads, worker tool cancellation and durable
context without stale cue restoration. PostgreSQL integration checks cover real
migrations, concurrent version updates, concurrent submission commits and authenticated
HTTP validation. Existing teaching tests retain instruction/drawing contract coverage.

Automated checks do not establish real-model lesson understanding or real Google
sign-in across two classroom devices. Before a pilot, run the walkthrough above with
one prepared Scratch project, teacher phase changes, lost tabs, a completed event
script and a failed/retried hand-in. Confirm that the tutor distinguishes the live
workspace from the tutorial illustration and does not mistake a typed URL or cursor
movement for completion.

## Role and navigation ownership

`AccountRole.ts` owns the Student/Teacher vocabulary. Prisma stores `User.role`;
`ClassroomService` reads it for teacher commands and retains class ownership checks.
Better Auth declares role as a server-owned field (`input: false`), so a signed-in
user cannot promote themselves with an account update. `AssignAccountRole.ts` is
an explicit operator command through `AccountRoles.ts`; neither renderer nor worker
receives an equivalent action. Role display comes from the authenticated Classroom
home snapshot, not an editable preference or cached model session.

`App.tsx` owns Workspace/Classroom navigation and the role badge. `ClassroomPage.tsx`
retains the participation UI state while hidden; main retains the actual binding.
Navigating does not stop guidance or discard chat drafts. Teacher lesson preparation
and class management remain focused components; student controls include enrollment,
explicit session joining, saved working references and confirmed hand-in.
