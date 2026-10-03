# HUD voiceover specification

Implementation added October 3, 2026. ElevenLabs is the speech provider;
live provider and signed installed acceptance remain unverified. See the
[engineering design](HudVoiceoverEngineering.md) and [delivery plan](HudVoiceoverPlan.md).

## Purpose and scope

When the assistant presents a teaching bubble, Tro reads it aloud while the user
can see the instruction and follow the guidance. Speech reads the exact accepted
message text; it does not ask another agent to rewrite or translate the message.

The first release reads `TeachingMessage` instructions, questions and completion
messages produced by typed or voice requests. It excludes user messages,
transcription previews, tool arguments/results, internal reasoning, status labels
and workspace replies without an accepted HUD message.

ElevenLabs generates speech; the OpenAI agent still generates guidance. This is
speech output, not a new conversational agent or a replacement for microphone
transcription. Use a configured voice; voice cloning and a marketplace UI are
outside this release.

## Language and voice

Display and speech share the accepted message's application locale. English
(`en`) and Vietnamese (`vi`) are initially supported. Resolve language before
agent generation and carry it with the message; a speech language cannot
translate text written in another language.

Tro saves its application language locally and defaults to Vietnamese. Read-aloud
follows that choice. If an OS-following mode is added separately, resolve one
supported application locale for agent text, HUD and speech together. Do not
silently overwrite an existing saved preference.

Select a voice from the backend `VoiceoverConfig.ts` map using
`DesktopLocale.VIETNAMESE` or `DesktopLocale.ENGLISH`. Both entries initially
use George from the ElevenLabs quickstart and can be changed independently. The API key
remains in Doppler; no voice-ID environment variables are required. Text and the
explicit language code follow the application locale. ElevenLabs lists English
and Vietnamese for Flash v2.5, the initial streaming candidate. Verify shortcuts,
names, numbers and mixed-language labels with the actual release voice.
[ElevenLabs models](https://elevenlabs.io/docs/overview/models#flash-v25).

Locale changes cancel speech and pending old-language requests. Only newly
accepted guidance in the new locale may be read. Unsupported combinations show
localized availability status and visual guidance, without silently switching
the spoken language.

## Presentation and timing

Show text and drawings after their normal admission. A matching message-visible
acknowledgment starts speech generation. Play once the first audio buffer is
ready; cloud speech adds network and synthesis delay. Do not promise simultaneous
text/audio start or delay the drawing for narration.

Keep the matching bubble visible through narration, subject to a bounded lease.
Normal reveal/hold remains a minimum. New guidance replaces both old text and
speech. Audio arriving after drawing ends may read the still-current bubble, but
must never read superseded guidance.

Read each message at most once automatically. Snapshot updates, meters, renewals,
rerenders and reconnects do not replay it or create another paid request. Word
highlighting and replay are deferred.

Speech is optional presentation. Its failure cannot fail an otherwise valid
lesson or supply evidence of a demonstrated step or completed task. Completion
messages may finish reading after task settlement; task completion never waits
for speech. New work can interrupt final narration.

## Controls and interruption

Provide app-local **Read guidance aloud**, initially enabled for supported
configured installations, and **Stop speaking**. Muting/stopping speech leaves the
lesson running. Re-enabling it applies to subsequent accepted messages and does
not replay previous or current guidance.

Stop and discard current audio when:

- New guidance, task or locale replaces it.
- Microphone capture is prepared, before input opens.
- Esc or the task Stop control cancels the lesson. Esc also stops completion
  narration and clears its HUD after the task has settled.
- Student input interrupts the relevant native preview, or its bubble is removed.
- Read-aloud is disabled, the user signs out, the window closes or Tro quits.
- Its task worker, driver, renderer or authenticated stream is lost.

Passive pointer motion, app focus changes and a minimized Tro window preserve
narration. Canceled capture does not replay old speech. Input admission must await
confirmed local silence; if playback stop fails, report capture unavailability
without opening the microphone over narration. Provider cancellation continues
independently of local silence.

## Availability, data and cost

Missing ElevenLabs configuration leaves voiceover unavailable while chat and
visual guidance continue. Network failure, provider failure, allowance exhaustion
and playback failure have concise localized status. Stalled requests expire;
there is no indefinite speaking state or bubble. Do not retry uncertain paid calls.

Guidance text goes through Tro's authenticated backend to ElevenLabs. No
screenshots, photographs, microphone input or tool payloads accompany it. Provider
credentials remain on the backend. Tro keeps message text/audio transient; usage
metadata may be stored for allowance and duplicate-request protection. Settings
explain that read-aloud uses cloud speech.

Provider retention follows the configured account. Zero-retention mode is an
Enterprise option, not a default guarantee.
[Retention documentation](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode).

One active utterance per account, bounded text and a daily character allowance
gate provider calls. Canceling does not guarantee billing is reversed. Numeric
limits and failure contracts belong to the engineering design.

## Acceptance

| Scenario                                             | Expected behavior                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Instruction, question or completion appears          | Same text is read in its locale while its bubble remains visible.         |
| Presentation is refused                              | No speech generation.                                                     |
| Duplicate progress, meter/lease refresh or reconnect | No repeated generation or narration.                                      |
| Guidance changes during generation/playback          | Old stream/buffers are canceled; only current guidance sounds.            |
| Voice shortcut held during narration                 | Playback stops before input opens; Tro does not transcribe its own voice. |
| Locale changes                                       | Old-language audio stops; next accepted message uses the new locale.      |
| Provider unavailable, slow or allowance exhausted    | Visual guidance continues, status appears and the speech lease expires.   |
| Stop speaking or mute                                | Audio stops without canceling teaching.                                   |
| App switch or minimized Tro                          | Narration continues without UI focus.                                     |
| Completion settles, then new work starts             | Final speech may finish unless replaced; new work cancels it.             |
| Sign-out/close/shutdown during startup               | No late audio starts and no playback survives teardown.                   |

Measure startup/interruption on signed macOS/Windows builds with the release
voice and account. Provider inference figures are not application latency
guarantees. Recorded installed acceptance is required before claiming support.
