export const voiceProfiles = {
  openai: { model: 'gpt-live-1', voice: 'marin', transport: 'live-websocket' },
  elevenlabs: { model: 'eleven_realtime_v1_max', transport: 'agents-websocket' }
} as const;
export type VoiceProvider = keyof typeof voiceProfiles;
export function selectProvider(value: unknown): VoiceProvider {
  if (value === undefined) return 'openai';
  if (value === 'openai' || value === 'elevenlabs') return value;
  throw new Error('invalid_provider');
}
