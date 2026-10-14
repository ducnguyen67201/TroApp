# Student QR access — engineering specification

Status: **Engineering specification. Core QR admission and account flows are
implemented locally; remaining requirements are proposed.** See the
[implemented architecture](Architecture.md#email-free-student-access) for current
scope and limitations. This document does not certify production readiness.

Date: 2026-10-14. Audience: product, desktop, API and persistence engineers.

The requested specification records the product discussion and
[interactive prototype](../examples/previews/StudentQrOnboarding.html).
The prototype uses fictional students, simulated scans and in-memory state; it
does not implement authentication or save accounts after reload.
[Architecture.md](Architecture.md) remains the description of implemented runtime
behavior. This document defines the proposed change, not a second architecture.

## Capability

Students under 16 can start a school-authorized lesson without email or a Google
account. They scan their existing school QR card, enter a display name and begin.
On a personal device, Tro remembers the resulting individual session and exposes
it through the existing sidebar account switcher. On a shared classroom device,
Tro keeps the school's device authorization between learners and clears each
learner's session at the end. Teachers can associate provisional profiles with a
school roster later.

**Critical input:** the customer confirmed that the existing QR contains only an
internal `studentId`. It identifies a claimed school record; it does not prove who
is scanning. A saved Tro session can restore its own account. A public student ID
alone cannot restore an existing private account on a different or signed-out
device.

### Product requirements and proposed decisions

| Classification             | Decision                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Required                   | No student email, Google account or daily password/PIN for the first lesson.                                                                 |
| Required                   | Reuse school QR cards and allow learning before roster synchronization.                                                                      |
| Required                   | Support both personal devices and company/classroom devices.                                                                                 |
| Required                   | Reuse the existing sidebar account switcher, including saved accounts, add and sign-out.                                                     |
| Required                   | Minimize teacher work: school/device setup once; no per-student approval during ordinary authorized lessons.                                 |
| Engineering invariant      | Treat the QR ID and entered name as unverified claims. Neither grants access to another profile or teacher functions.                        |
| Proposed MVP               | Remember personal sessions; use temporary, restricted learner sessions on shared devices.                                                    |
| Proposed commercial policy | Count concurrent active learners independently of the number of installations or saved accounts. Confirm before implementation of licensing. |
| Open                       | Private account recovery on a new device, exact session durations, admission distribution and roster-provider integration.                   |

## Constraints

### Identity, authorization and entitlement

1. Tro's canonical user ID owns learning data. A school student ID is an external
   identifier, never the primary key for Tro accounts, sessions or progress.
2. Scope an external ID by school and roster source. The same text in two schools
   must not collide. Preserve leading zeros, case and other supplier semantics;
   define normalization only after inspecting the actual QR format.
3. Scanning an ID must not select, overwrite, merge or recover an existing account.
   Two devices presenting the same unverified ID may create separate provisional
   profiles. Mark the conflict for review instead of assigning ownership to the
   first scanner.
4. The backend establishes school, allowed class/lesson, device mode, admission
   permission and usage allowance. A QR, display name or renderer-supplied role
   cannot establish these rights.
5. Device authorization permits learner admission within its scope. It is not a
   teacher session and cannot call teacher, roster-management or admin APIs.
6. Roster association, verified identity, classroom enrollment, remembered login
   and paid usage are separate decisions. Advancing one must not silently advance
   the others.
7. A personal session gives access to the new profile's own work. A shared session
   exposes only its current authorized lesson and work; it cannot read historical
   work belonging to the claimed school ID.

### Data and desktop boundaries

- Keep canonical user IDs stable when adding roster metadata or verified links.
  Preserve progress and audit history. Do not merge profiles by name or QR match.
- Collect a display name and scoped external ID for onboarding. Do not require
  date of birth, email, phone number or a photograph.
- Keep credentials in Electron main and OS-protected storage. Only validated
  account metadata crosses preload. Renderer storage must not contain session
  credentials, activation secrets or teacher tokens.
- Shared mode must not read or display the personal account vault. Configure a
  dedicated shared application storage context, or fail closed if personal
  sessions are present; never silently delete them while changing device mode.
- Use strict TypeScript and owning Zod contracts, feature-owned application ports,
  Prisma persistence adapters and reviewed additive migrations. Preserve existing
  Google accounts and classroom authorization.
- Publicly reachable email-less admission requires server-side admission limits,
  usage budgets and revocation before rollout. Possession of a device activation
  code is not an unlimited model-use entitlement.

## Implementation contract

### Actors and surfaces

| Actor                             | Allowed responsibility                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Authorized school staff           | Configure school admission, approve/revoke devices, control class availability and review roster associations. |
| New learner                       | Scan or enter an ID, choose a display name and enter an authorized lesson.                                     |
| Returning personal-device learner | Resume or select a previously saved, valid individual session.                                                 |
| Shared-device learner             | Start a fresh restricted lesson session and end it without exposing another learner's work.                    |
| Desktop main                      | Store credentials, verify sessions, enforce transitions and isolate local work.                                |
| API                               | Resolve authorization, enforce school/class isolation, persist work, meter usage and revoke access.            |

Staff use their authenticated device for setup. A shared learner computer must not
retain a staff login. Prefer a short-lived activation approval or code redeemed on
the classroom computer, with a separate revocable device grant issued afterward.
Personal devices also need a school-authorized admission mechanism, such as a
bounded school invitation. The public school student QR does not supply this.

### Device behavior

| Behavior               | Personal device                                            | Company/classroom device                                                                |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Device configuration   | Trusted personal mode in an authorized school context.     | Staff-activated shared mode in an authorized school/class context.                      |
| First use              | Scan → display name → create provisional profile → lesson. | Scan → display name → create provisional profile/session → current lesson.              |
| Restart                | Verify and resume the selected saved session.              | Return to fresh scan; never resume the previous learner.                                |
| Account menu           | Previously added accounts on this device.                  | Current learner only; offer “Đổi học sinh”.                                             |
| History                | This saved profile's own authorized history.               | Current session's work only.                                                            |
| End                    | Sign out removes the selected local session.               | Change learner, explicit finish, idle expiry, class end or app exit clears the learner. |
| Retained authorization | Individual credentials, encrypted, while valid.            | Narrow school/device grant; no durable personal learner credential.                     |

“Name once” is an MVP promise for a remembered personal profile. With the current
ID-only school card, a new shared session may need a name again. Reliable private
history across shared or new devices requires an additional verified login or
private recovery credential. Do not hide this limitation behind automatic ID
matching. School authorization may allow the current lesson to start without a
teacher approving each scan.

### Student journeys

#### First personal-device lesson

1. Resolve a valid school admission grant before accepting a student QR. Show the
   school name so the learner can recognize the context.
2. Open a scan view on an explicit user action. Provide manual ID entry if the
   camera is missing, denied or unavailable. Neither path is stronger identity
   verification.
3. Parse a bounded supported QR payload locally. Do not navigate to arbitrary QR
   URLs. Ask for a display name; render it as text.
4. Submit an idempotent onboarding request. The API creates a canonical user,
   provisional learner profile, unverified external-ID claim and scoped session.
   It may admit the learner only to the lesson allowed by the grant.
5. Main stores the session securely, then activates it. Show “Chào {name}!” and
   the permitted lesson. Indicate that this personal device remembers the learner.
6. On restart, verify the saved session with the API before displaying private
   data or enabling model use. Invalid sessions require recovery; temporary
   verification failures offer retry without discarding accounts.

Never look up an existing private profile by the submitted QR to complete step 4.
If an encrypted vault write fails, do not claim that login was remembered. Clear
the uncommitted local credential and revoke it where possible; a retry must not
create a second profile for the same onboarding operation.

#### Saved accounts and sidebar switching

Extend the existing [AccountMenu](../src/desktop/renderer/accounts/AccountMenu.tsx).
Use the same bottom avatar trigger and popup layout shown in the customer's
reference screenshot.

| Element                   | Required behavior                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heading                   | “Chuyển tài khoản”.                                                                                                                                                                 |
| Subtitle                  | “Tài khoản trên máy này”. This lists saved logins, not the class roster.                                                                                                            |
| Student row               | Avatar, display name, “HỌC SINH” badge and “Mã học sinh · {id}” in place of email.                                                                                                  |
| Current row               | Highlight and checkmark; selecting it makes no transition.                                                                                                                          |
| Other row                 | Verify that account's saved session before committing the switch.                                                                                                                   |
| “Thêm tài khoản”          | Open QR/name onboarding in personal mode. Preserve the original session until the new account succeeds. Keep the existing Google path available for eligible personal-device users. |
| Cancel or close add       | Return to the original account and work unchanged. Closing/reopening the account popup does not erase an in-progress form.                                                          |
| “Đăng xuất tài khoản này” | Revoke/remove only the current session. Preserve the profile, work and other saved accounts.                                                                                        |
| After sign-out            | Show an explicit saved-account chooser if accounts remain; otherwise show sign-in/scan. Do not automatically open another child's account.                                          |
| Expired row               | Mark as needing sign-in. A rescan of its public student ID cannot restore private history.                                                                                          |

Retain the existing account limit owned by
[DesktopAccounts.ts](../src/contracts/DesktopAccounts.ts), unless separately
changed. When full, explain the limit before creating another learner/session.

The popup must support X, outside click, Escape, Tab/Shift+Tab containment and
focus return to its trigger. Preserve accessible dialog naming, expanded state and
current-account indication. Long names/IDs must fit without hiding actions; the
popup and scan flow must remain usable at narrow window sizes.

Reusing a valid remembered session assumes the device/OS user is trusted. Anyone
who can use that unlocked personal session can select its remembered accounts;
the account menu is not an identity check. Shared school computers must use shared
mode rather than this convenience behavior.

#### Shared-device lesson and cleanup

1. Verify device authorization and current class availability.
2. Scan/name onboarding creates a fresh limited learner session. Do not restore
   an old account, reveal a roster list or offer remembered personal accounts.
3. Save work server-side under this session's canonical provisional user ID.
   Teachers see provisional attribution until a separate review establishes a
   verified association.
4. “Đổi học sinh” or finish stops active work, attempts bounded flushing of
   pending work, ends the learner session and returns to the scan screen. Do not
   show a success message for work that was not saved.
5. Idle expiry, class closure and app termination also invalidate access. On
   startup, discard any unfinished shared learner context. Server expiry and
   revocation must cover crashes and missing shutdown requests.

Clear learner-specific renderer state, work previews, local caches, clipboard
content written by Tro where safely attributable, camera tracks, voice/capture
state, workers and pending responses. Reuse existing classroom binding/lease
invalidation. Retain only the narrow shared-device grant and non-sensitive app
settings. Failed cleanup must block the next learner from entering the old state.
Unsaved private work must not remain on screen for the next student.

#### Deferred roster association

1. Authenticated staff submit a bounded roster batch in their school/source scope.
   MVP may use a supported file import; provider synchronization is a later adapter.
2. Produce a preview with matched claims, missing entries, duplicates and conflicts.
   Match exact scoped IDs; names are display information.
3. Staff review and apply a versioned batch. Recheck staff scope, roster revision
   and conflicts at commit. Repeated application must be idempotent.
4. Attach roster metadata without changing canonical user IDs or losing work.
   Keep competing claims separate and visibly provisional.
5. Verified identity association is a separate operation requiring independent
   evidence, such as a supported school-provider login or an authorized staff
   confirmation of the learner. Record evidence type and reviewer in restricted
   audit data. A roster import alone is not evidence that the scanner is that child.

Association must not silently grant account recovery, expose old private work,
merge existing Google users or grant classroom access. Any later history transfer
needs an explicit reviewed operation with provenance and a recovery strategy.

### State and transition rules

| Object          | Required states/transitions                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device          | Unconfigured → activation pending → authorized personal/shared → expired or revoked. Mode change requires staff authorization and safe local isolation.       |
| Onboarding      | Ready → scanning/manual entry → name entry → submitting → session ready; cancel returns to the original context. Failure permits bounded retry.               |
| Learner session | Active → expired/revoked. Personal active sessions may be remembered; shared sessions remain memory-only. Revoked sessions cannot be revived by an ID rescan. |
| Local selection | None → verifying target → selected. Failed verification retains the prior selection; explicit sign-out returns to a chooser.                                  |
| Identity claim  | Unverified → metadata associated, disputed or independently verified. Metadata association never implies verified identity.                                   |
| Roster batch    | Uploaded → previewed → applied or rejected. Stale/conflicting previews cannot commit silently.                                                                |

Account changes reuse
[AccountTransitionGate](../src/desktop/main/accounts/AccountTransitionGate.ts)
and existing generation guards. During active tasks or classroom operations,
explain that work must finish or stop before switching. Do not silently abort
work to open another account. Verify the target before committing; on commit,
detach the old binding and clear old learner state. Late API/worker replies from
the old generation must not mutate the newly selected learner.

### Backend access contract

Introduce a shared authorization resolver that preserves the authenticated
principal's restrictions. Proposed principal fields are canonical `userId`,
session ID/kind, school ID, device ID, optional class/meeting scope, allowed
capabilities, expiry and revocation revision. These are server-derived values;
preload account metadata is not authorization evidence.

Every learner-accessible operation must authorize the operation and resource in
that scope. Passing a learner `userId` into today's general signed-in-user path
without retaining restrictions is insufficient. Teacher/admin routes continue to
require existing server-owned roles and ownership checks. A shared learner cannot
use the general history, social sharing, roster or teacher surfaces merely because
it has a canonical user ID.

Use revocable high-entropy credentials over HTTPS. Protect cookie-based mutations
against CSRF; if a dedicated bearer-session adapter is selected, keep credentials
in main and apply the equivalent origin/sender boundary checks. Neither credential
kind is embedded in the school QR.

The following are proposed versioned HTTP operations, not existing wire contracts.
Finalize naming with the owning API schemas; reject unknown input fields and apply
bounded payloads, request timeouts and rate limits.

| Operation                      | Caller/input                                                                 | Result and invariant                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Create device activation       | Authenticated staff; school, device mode, permitted class/admission policy.  | Short-lived activation challenge; no teacher credential in the result.                     |
| Redeem activation              | Desktop main; challenge and proof bound to the pending activation.           | Restricted device grant. One-time redemption; expiry and brute-force limits.               |
| Create learner session         | Authorized admission/device grant; request ID, external ID and display name. | New provisional user plus scoped learner session; never a private-account lookup.          |
| Verify/refresh learner session | Main; existing valid credential.                                             | Validated account metadata and effective capabilities, or typed expiry/revocation failure. |
| Revoke session/device          | Session owner for own sign-out; authorized staff for device/school scope.    | Idempotent revocation; device revocation denies dependent learner admission/use.           |
| Preview/apply roster           | Authorized staff; source, batch and expected revision.                       | Scoped preview/apply result; no implicit session creation or identity verification.        |
| Verify association             | Authorized staff/provider path; claim, target and evidence.                  | Audited verified link or conflict; no automatic profile merge.                             |

Onboarding idempotency is scoped to the admission/device context and request ID,
with a payload digest. Retrying the same operation creates at most one canonical
user, claim and permitted enrollment. A different payload with the same key is a
conflict. Credential delivery after an uncertain response must rotate/invalidate
the previous credential for that operation rather than storing plaintext replay
tokens. Apply profile/claim/session/enrollment/audit writes transactionally.

Errors must distinguish invalid input, expired admission, closed class, busy
transition, capacity/usage limit, storage failure and temporary service failure.
Responses must not reveal whether a different student's private account exists.

### Logical data model

This is a responsibility model, not a migration script. Reuse existing entities
where their semantics match; avoid creating a second owner for progress.

| Entity                             | Ownership and constraints                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| School and staff membership        | Explicit tenant boundary and staff authority; new because current classes are teacher-owned.                                     |
| Roster source/student              | Source belongs to school; authoritative external ID unique within school/source.                                                 |
| Device registration/grant          | School, configured mode, admission scope, expiry/revocation and last use. No teacher privileges.                                 |
| Learner profile                    | Canonical `User.id`, display name and provisional lifecycle. Learning records keep their existing user foreign keys.             |
| Student identity claim             | Canonical user, school/source/external ID, status and timestamps. Multiple unverified claims may reference the same external ID. |
| Verified association               | Independently established relationship and evidence provenance; enforce uniqueness/conflict policy separately from claims.       |
| Learner session                    | Canonical user, device/admission scope, expiry/revocation and credential digest through the selected supported auth adapter.     |
| Roster import/review               | Batch identity, revision, preview/apply status and restricted audit provenance.                                                  |
| Classroom enrollment/participation | Existing records and binding leases; add explicitly authorized email-less admission rather than bypassing service checks.        |

### Current implementation and required integration

| Existing owner                                                                                                                                                                                       | Required change or review                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AuthDatabase.ts](../src/server/persistence/AuthDatabase.ts)                                                                                                                                         | Google-only Better Auth setup resolves a user ID. Select a supported email-less adapter and preserve a scoped principal through application services.                                                               |
| [schema.prisma](../prisma/schema.prisma)                                                                                                                                                             | `User.email` is required and unique; learning data references `User.id`. Design compatible email-less persistence without synthetic email addresses or a parallel progress identity.                                |
| [AuthSession.ts](../src/contracts/AuthSession.ts) and [DesktopAccounts.ts](../src/contracts/DesktopAccounts.ts)                                                                                      | Current strict metadata requires email and add-account means Google. Add explicit versioned account/session kinds and learner commands; keep role/admin fields server-owned.                                        |
| [AccountSessions.ts](../src/desktop/main/accounts/AccountSessions.ts)                                                                                                                                | Add credential-kind verification, personal learner records, safe add/cancel/switch and shared-mode exclusion while preserving generation guards.                                                                    |
| [EncryptedAccountVault.ts](../src/desktop/main/accounts/EncryptedAccountVault.ts)                                                                                                                    | Current encrypted vault is versioned and stores Google cookies. Migrate atomically, preserve existing accounts on failure and never fall back to plaintext.                                                         |
| [AccountMenu.tsx](../src/desktop/renderer/accounts/AccountMenu.tsx)                                                                                                                                  | Reuse the popup; render learner ID instead of email and mode-appropriate actions.                                                                                                                                   |
| [ClassroomService.ts](../src/server/features/classroom/application/ClassroomService.ts) and [RegisterClassroomRoutes.ts](../src/server/features/classroom/infrastructure/RegisterClassroomRoutes.ts) | Existing admission paths use verified email. Introduce explicit scoped learner admission; keep existing email invitations and teacher checks intact.                                                                |
| [StartApi.ts](../src/server/StartApi.ts)                                                                                                                                                             | Wire scoped principal resolution into every newly accessible route, not just onboarding.                                                                                                                            |
| [RegisterModelGateway.ts](../src/server/auth/RegisterModelGateway.ts) and [ModelCredentials.ts](../src/server/auth/ModelCredentials.ts)                                                              | Bind learner model authorization to effective session/school scope and enforce revocation plus usage limits at provider admission. Existing user-bound model credentials alone do not establish those restrictions. |
| [Main.ts](../src/desktop/main/Main.ts) and [MicrophonePermission.ts](../src/desktop/main/voice/MicrophonePermission.ts)                                                                              | Current media permission policy is audio-oriented. Add camera access narrowly for the owned scan surface and explicit gesture; stop tracks on completion, cancel, switch and exit.                                  |

**Architecture gate:** prove the selected email-less auth approach against the
installed Better Auth/Electron integration and a disposable database before
finalizing contracts or migrations. Making `email` nullable alone is not a
demonstrated integration. If a dedicated learner-session adapter is needed, it
must share canonical users and scoped authorization resolution with existing
accounts. Do not weaken library declarations, invent fake email addresses or
relax existing session schemas to accept arbitrary shapes.

Coordinate strict contract changes with desktop/API version compatibility. Older
clients continue to receive supported Google-account responses; they must not
receive a learner shape they cannot parse. New clients must detect an older API
and keep email-less onboarding unavailable with a clear explanation.

### Limits, persistence and failures

- Separate school entitlement, device grants, active learner capacity and paid
  usage. Saved account rows are not active seats. If concurrent seats are adopted,
  acquire/release expiring leases atomically and cover crash recovery. Do not
  deduplicate provisional learners by their unverified school ID.
- Reserve/check budget before paid provider work; concurrent requests cannot
  exceed an allowance through races. Revalidate revocation and class availability
  at provider admission. Session cleanup also cancels pending issuance/work where
  supported; revoked sessions must not continue minting model credentials.
- No offline onboarding, activation or new paid work in MVP. If a connection fails,
  retain safe input for retry within the same context and do not claim work saved.
  Discard shared learner input/state when ending that session.
- Sign-out removes local selection/credential immediately after safe task cleanup.
  If remote revocation fails, do not restore the local login or claim remote
  revocation succeeded. Queue a bounded secure retry where available and rely on
  server expiry as the backstop. Document the maximum residual lifetime.
- Server-side class closure/device revocation denies subsequent protected work.
  Shared idle timeout uses a defined user-activity policy, not background polling
  or heartbeat traffic. Warn before interactive idle expiry where possible.
- Rate-limit QR/manual submissions, activation redemption and provisional-profile
  creation per authorized context. Invalid scans must not trigger paid calls.

### Observability and data lifecycle

Record bounded events for activation, admission, session verification, account
transition, shared cleanup, roster apply and usage rejection. Include operation,
stage, safe reason, request correlation ID, duration and aggregate counts. Keep
names, external student IDs, QR payloads/images, cookies, tokens and credentials
out of ordinary logs and analytics.

Restricted audit records may reference internal actor, profile, school and device
IDs with the operation, evidence category and timestamp. Define access and
retention with the school before rollout. Provisional profiles, abandoned claims,
work retention and deletion/export requests need explicit policies; do not invent
jurisdictional consent rules in code. School reporting must distinguish unverified
attribution from verified students.

### Acceptance criteria

| ID  | Scenario                      | Pass condition                                                                                                             |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A01 | New personal learner          | Authorized QR/name onboarding reaches a permitted lesson without email and saves an encrypted individual session.          |
| A02 | Personal restart              | Valid session restores its own profile; expired/temporary-failure paths do not expose unverified private data.             |
| A03 | Saved account menu            | Student name, role, ID, current checkmark, add and sign-out match the agreed popup; no class roster appears.               |
| A04 | Add/cancel                    | Cancel, popup dismissal and failed add preserve the original session, work and form state as specified.                    |
| A05 | Switch                        | Target is verified before commit; failed/busy transitions retain original context; late responses cannot cross accounts.   |
| A06 | Sign-out                      | Only the selected credential is removed/revoked; other saved accounts and server work survive; no account auto-opens.      |
| A07 | Last sign-out                 | Restart and public-ID rescan cannot resurrect the signed-out private account.                                              |
| A08 | Shared isolation              | Second learner cannot see prior learner state, saved personal accounts, teacher sessions or private history.               |
| A09 | Shared termination            | Finish, idle, class end, revocation, exit and crash/restart clear local learner access; expiry covers missed shutdown.     |
| A10 | Same ID on two devices        | Separate provisional claims remain separate; neither scanner gains the other's work.                                       |
| A11 | Tenant isolation              | Same external ID in two schools stays isolated; forged school/class/mode inputs and out-of-scope requests fail.            |
| A12 | QR/camera failure             | Unsupported/oversized payload is rejected; denied camera offers manual entry; arbitrary QR URLs never open.                |
| A13 | Uncertain onboarding response | Retry does not duplicate user/claim/enrollment; credential redelivery follows rotation and conflict rules.                 |
| A14 | Roster review                 | Repeated apply is idempotent; stale/conflicting batches fail safely; metadata association grants no login/history rights.  |
| A15 | Existing accounts             | Google login, role checks, email invitations and encrypted vault contents continue working through migration and rollback. |
| A16 | Limits/revocation             | Concurrent admission/provider requests respect configured limits; revoked or closed scope cannot issue new model access.   |
| A17 | Vault/network failure         | No plaintext fallback, false remembered/saved message, discarded existing vault or accidental account selection.           |
| A18 | Accessibility                 | Keyboard focus stays in popup, Escape/X/outside close returns focus, and narrow windows keep all actions usable.           |
| A19 | Privacy                       | Logs and preload responses contain no session secrets or QR imagery; reports label provisional attribution.                |
| A20 | Client compatibility          | Old API/client combinations fail predictably without corrupting vaults or exposing unsupported learner payloads.           |

## Non-goals

- Authenticating a child from a public student ID, automatically merging profiles
  or restoring private history from that QR on a new device.
- Requiring daily student PINs/passwords or teacher approval for each ordinary scan.
- Shipping a school-provider integration, automatic roster synchronization,
  account recovery or reviewed history-transfer tool in the first onboarding slice.
- Device fleet management, hardware fingerprint licensing, commerce/pricing changes
  or a new distributed identity service.
- Implementing or releasing runtime behavior through this specification or prototype.

## Open questions

| Decision                                    | Proposed direction / required evidence                                                                                                                                                | Blocks                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Actual QR payload                           | Obtain non-sensitive sample values and supplier rules for format, case, leading zeros and source identity.                                                                            | Parser and import contracts.                 |
| School ownership and admission distribution | Explicit school/staff ownership; bounded activation for shared computers and a school invitation for personal devices. Confirm how learners receive it without repeated teacher work. | Tenant schema and onboarding authorization.  |
| Email-less auth integration                 | Local compatibility spike; retain canonical user IDs and existing Google/vault behavior.                                                                                              | Session contracts and migrations.            |
| Shared-device identity continuity           | MVP creates fresh restricted sessions. Decide whether later school-provider verification or a private recovery credential is needed for persistent history and repeated name entry.   | Any promise of cross-device continuity.      |
| Session and limit policy                    | Choose activation/session/idle/refresh lifetimes, revocation backstop, request bounds and usage budgets; keep fixed values with their owning validated config.                        | Production admission and cleanup behavior.   |
| Licensing metric                            | Recommended concurrent active learners; confirm against the customer's commercial agreement before enforcing seats.                                                                   | Entitlement enforcement and staff UI.        |
| Data lifecycle and identity review          | School-approved provisional retention, staff verification evidence, conflicting-claim resolution and deletion/export ownership.                                                       | Production roster association and reporting. |

These decisions must be resolved explicitly; suggested directions are not customer
commitments. The prototype is evidence for interaction design, not evidence that
authentication, school ownership or licensing has already been chosen.

## Handoff

**Ready for architecture review and implementation slicing.** Auth compatibility,
school admission and policy values are gates before production implementation can
be considered complete.

1. **Prove auth and migration compatibility.** Exercise the selected session adapter,
   canonical email-less user persistence, Google coexistence, versioned contracts,
   encrypted vault migration and rollback against local fixtures/disposable DB.
2. **Implement school admission and restricted backend access.** Add minimal tenant
   ownership, device grants, provisional claims, transactional onboarding,
   revocation, scoped route authorization and provider usage limits.
3. **Extend personal onboarding and existing accounts.** Add QR/manual input, camera
   lifecycle, display-name form, secure session persistence and the existing
   account menu's learner variant. Cover A01–A07 and transition failures.
4. **Implement shared lifecycle.** Isolate storage, restrict capabilities, clear all
   learner state and verify crash/idle/class-end behavior before classroom use.
5. **Add deferred roster review.** Preview/apply metadata associations without
   identity uplift; ship verified linking only with its evidence and conflict policy.
6. **Pilot after acceptance checks.** Use synthetic data first, then a scoped school
   pilot with agreed limits and retention. Rollback disables new admission while
   preserving users/work and access to existing Google accounts; do not roll back
   by deleting learner data or restoring an incompatible vault.

Follow [README.md](../README.md) for the maintained validation commands. Runtime
implementation requires unit/contract checks for authorization and transitions,
disposable-database integration coverage for migration/idempotency/isolation, and
desktop interaction checks for account switching, permissions and cleanup. Keep
all routine checks independent of private credentials or paid providers. Update
[Architecture.md](Architecture.md) only when the runtime changes are implemented.
