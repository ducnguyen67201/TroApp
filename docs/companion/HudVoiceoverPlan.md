# HUD voiceover plan

Implementation added October 3, 2026, from main commit `969fda6` on
`codex/hud-voiceover`. Provider credentials are not configured by this change;
a locale-to-voice map is held in backend `VoiceoverConfig.ts`. The [specification](HudVoiceoverSpec.md) owns behavior and the
[engineering record](HudVoiceoverEngineering.md) describes the delivered modules.

The simple implementation uses a private bounded HUD reader and Web Audio buffers,
replacing the proposed native subscription and playback worklet. The earlier local
system speech proposal is superseded by ElevenLabs.

## Decisions

- Use ElevenLabs for text-to-speech. The OpenAI agent and transcription flow
  retain their existing responsibilities.
- Read the exact accepted `TeachingMessage` text in its resolved application
  locale. Initial languages are English and Vietnamese. Tro stores its language
  setting locally and defaults to Vietnamese; OS-following language selection
  would require a separate explicit localization change.
- Compose a dedicated voiceover controller through the chat controller, with
  provider generation, playback and HUD presentation behind explicit ports.
- Keep the ElevenLabs key in backend Doppler configuration. Store public voice
  IDs in `VoiceoverConfig.ts`, keyed by `DesktopLocale.VIETNAMESE` and
  `DesktopLocale.ENGLISH`. Both initially use George from the official quickstart
  and can be changed independently; language follows the app locale. Electron main authenticates to Tro;
  the sandboxed renderer receives bounded audio.
- Use one complete message per streaming TTS request. Flash v2.5 is the initial
  candidate; verify account access, voice pronunciation, audio format and actual
  latency before fixing release configuration.
  [Provider models](https://elevenlabs.io/docs/overview/models#flash-v25).
- Start generation from a correlated native message-visible signal. Audio starts
  when its first playable buffer arrives; text and drawings do not wait on it.
- Replace obsolete narration, stop before microphone capture, cancel on relevant
  task/presentation interruption and preserve visual guidance on speech failure.

## Existing timing gap

`TeachingPresenter` publishes a teaching message after `showTeachingCue` returns.
Native code installs the bubble before drawing, but returns after drawing playback.
Starting speech from ordinary progress can therefore lag behind the demonstration.

`CompanionHudClient` coalesces/restores snapshots and renews its lease. Snapshots
describe current presentation; they do not authorize generation or replay. Add a
private early lifecycle signal preserving message identity, separate from final
paired presentation evidence.

## Delivery record

1. Remaining release work: run an explicitly authorized provider feasibility check for the release voice,
   English/Vietnamese, Flash v2.5, raw audio and packaged background playback.
   Measure bubble-visible-to-first-audio latency and cancellation.
2. Added pending-message progress and a private installed-message reader while
   preserving V2 receipts and teaching outcomes.
3. Added backend streaming, provider/configuration ports and atomic Prisma usage
   admission through an additive migration; tests use fake providers.
4. Added the chat-composed controller, validated playback bridge and bounded
   Web Audio scheduling with microphone stop coordination.
5. Added local read-aloud preferences, translated settings/status, stop-speaking
   and completion-bubble hold.
6. Final repository checks passed: lint, formatting, type checks, 496 unit tests,
   eight integration tests and build. Native companion build/tests and teaching
   flow/native boundary checks also passed; installed audio and paid provider
   acceptance remain separate release work.

## Completion conditions

One displayed message creates at most one provider generation; its audio overlaps
a visible bubble and follows the displayed locale. Stale audio cannot survive
replacement or interruption. Microphone capture cannot open over active narration.
Speech failure leaves teaching usable. Authentication, allowance races, duplicate
requests, stream cleanup and packaged playback all need evidence.

Release voice acceptance and account retention settings remain release inputs. No
paid provider test, credential change or deployment was performed.
Do not claim voice selection, zero retention or installed playback acceptance
before those checks have been completed.
