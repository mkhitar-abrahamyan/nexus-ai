/**
 * Call recordings kept where your application keeps its assets, under a retention policy: a
 * finished recording's audio is fetched from the provider, stored in an `AssetStore` (in memory, on
 * disk, or in an S3 bucket) to expire when the policy says, and deleted at the provider, so it is
 * kept in one place, for as long as you decided.
 */
import type { AssetStore } from '../images/asset-support.js';
import type { TelephonyRecording } from '../types/telephony.js';
import type { TelephonyManager } from './manager.js';

/** How long a recording is kept. One of the two. */
export interface RecordingRetention {
  /** In days. */
  days?: number;
  /** In seconds. */
  seconds?: number;
}

/** Options for `recordingKeeper()`. */
export interface RecordingKeeperOptions {
  /** The telephony client the recordings come through. */
  telephony: TelephonyManager;
  /** Where they are kept. */
  store: AssetStore;
  /** How long they are kept. A store removes each once it expires, at its next `sweep()`. */
  retention: RecordingRetention;
  /** The tenant a recording is kept for: one for all, or chosen per recording. */
  tenantId: string | ((recording: TelephonyRecording) => string);
  /** Deletes the provider's copy once it is kept. Defaults to true. */
  deleteFromProvider?: boolean;
  /**
   * Claims a recording before keeping it, by its id, so a callback the provider retries keeps it
   * once: false when it was claimed already. Defaults to remembering the last 10,000 in this
   * process; give one backed by a shared store when several replicas take the callback.
   */
  claim?(recordingId: string): boolean | Promise<boolean>;
  /** Releases a claim when keeping failed, so the provider's retry is kept. */
  release?(recordingId: string): void | Promise<void>;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** A recording kept. */
export interface KeptRecording {
  /** The asset it is kept as. */
  assetId: string;
  /** The tenant it is kept for. */
  tenantId: string;
  /** The recording, as the provider reported it. */
  recording: TelephonyRecording;
  /** ISO-8601 time it expires. */
  expiresAt: string;
  /** Its size, in bytes. */
  bytes: number;
  /** Its MIME type. */
  mimeType: string;
  /** Whether the provider's copy was deleted. False when that was not asked for, or failed. */
  deletedFromProvider: boolean;
}

/** Call recordings kept under a retention policy, from `recordingKeeper()`. */
export interface RecordingKeeper {
  /**
   * Keeps a finished recording: fetches its audio, stores it to expire on the policy, and deletes
   * the provider's copy. Resolves to `undefined` for a recording already claimed.
   */
  keep(
    recording: TelephonyRecording,
    options?: { tenantId?: string; signal?: AbortSignal },
  ): Promise<KeptRecording | undefined>;
  /**
   * Keeps the recording a provider's recording callback reports. Resolves to `undefined` for a body
   * that reports no finished recording, or one already kept.
   */
  handle(
    provider: string,
    body: string | URLSearchParams | Record<string, unknown>,
  ): Promise<KeptRecording | undefined>;
  /** Removes the recordings past their retention from the store, and resolves to how many. */
  sweep(): Promise<number>;
}

const REMEMBERED = 10_000;

/**
 * Keeps call recordings in an asset store under a retention policy.
 *
 * ```ts
 * const recordings = recordingKeeper({
 *   telephony: ai.telephony,
 *   store: new S3AssetStore({ client, bucket: 'recordings' }),
 *   retention: { days: 30 },
 *   tenantId: (recording) => tenantOfCall(recording.callId),
 * });
 * // The provider's recording callback:
 * await recordings.handle('twilio', await request.text());
 * // Nightly:
 * await recordings.sweep();
 * ```
 */
export function recordingKeeper(options: RecordingKeeperOptions): RecordingKeeper {
  const seconds = options.retention.seconds ?? (options.retention.days ?? Number.NaN) * 86_400;
  if (!(seconds > 0)) throw new Error('A recording retention needs days or seconds, more than zero');
  const now = options.now ?? (() => new Date());
  const seen = new Set<string>();
  const claim =
    options.claim ??
    ((id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > REMEMBERED) seen.delete(seen.values().next().value as string);
      return true;
    });
  const release = options.release ?? ((id: string) => void seen.delete(id));

  const keep: RecordingKeeper['keep'] = async (recording, keepOptions = {}) => {
    const id = `${recording.providerUsed}:${recording.recordingId}`;
    if (!(await claim(id))) return undefined;
    const tenantId =
      keepOptions.tenantId ?? (typeof options.tenantId === 'function' ? options.tenantId(recording) : options.tenantId);
    let kept: Omit<KeptRecording, 'deletedFromProvider'>;
    try {
      const audio = await options.telephony.downloadRecording({
        provider: recording.providerUsed,
        recording,
        ...(keepOptions.signal ? { signal: keepOptions.signal } : {}),
      });
      const expiresAt = new Date(now().getTime() + seconds * 1_000).toISOString();
      const stat = await options.store.put(
        {
          location: { kind: 'bytes', data: audio.bytes },
          mimeType: audio.mimeType,
          filename: `${recording.recordingId}.${recording.format ?? (audio.mimeType.includes('wav') ? 'wav' : 'mp3')}`,
          metadata: {
            kind: 'call-recording',
            callId: recording.callId,
            recordingId: recording.recordingId,
            provider: recording.providerUsed,
            ...(recording.durationSeconds !== undefined ? { durationSeconds: recording.durationSeconds } : {}),
          },
        },
        {
          tenantId,
          provenance: {
            provider: recording.providerUsed,
            operation: 'upload',
            requestId: recording.recordingId,
            metadata: { kind: 'call-recording', callId: recording.callId },
          },
          expiresAt,
        },
      );
      kept = {
        assetId: stat.assetId,
        tenantId,
        recording,
        expiresAt: stat.expiresAt ?? expiresAt,
        bytes: audio.bytes.byteLength,
        mimeType: audio.mimeType,
      };
    } catch (error) {
      await release(id);
      throw error;
    }
    if (options.deleteFromProvider === false) return { ...kept, deletedFromProvider: false };
    // The recording is kept: a copy left at the provider is reported, not a failure to keep it.
    const deleted = await options.telephony
      .deleteRecording({
        provider: recording.providerUsed,
        recordingId: recording.recordingId,
        ...(keepOptions.signal ? { signal: keepOptions.signal } : {}),
      })
      .then(
        () => true,
        () => false,
      );
    return { ...kept, deletedFromProvider: deleted };
  };

  return {
    keep,
    async handle(provider, body) {
      const recording = options.telephony.parseRecordingCallback(provider, body);
      return recording ? keep(recording) : undefined;
    },
    async sweep() {
      return options.store.purgeExpired();
    },
  };
}
